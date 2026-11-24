/* c8 ignore next */
import * as path from 'path';
import { ParseContext } from './otelParse';
import { locateClaudeCodeLogDirs } from './locate';
import { CLAUDE_FALLBACK_TOKEN_PRICES, priceTokens, resolveMultiplier } from '../domain/pricing';
import { Surface, UsageEvent } from '../domain/types';
import { PricingService } from '../pricing/PricingService';
import { DuckDBFileReader } from '../store/DuckDBFileReader';
import type { IMetaStore as MetaStore } from '../store/MetaStore';
import { BaseFileConnector } from './BaseFileConnector';
import {
  AnyRecord,
  num,
  parseTimestamp,
  TokenBreakdown,
} from './connectorUtils';
import type { ConnectorCapabilities } from './LogConnector';
import type { IWorkspaceFolderMatcher } from './WorkspaceFolderMatcher';
import type { IFsWatcher } from './IFsWatcher';
import type { Logger } from '../util/logger';

/** Model id Claude Code writes for locally generated (non-API) assistant lines. */
const SYNTHETIC_MODEL = '<synthetic>';

/** True when an assistant message's content blocks include a tool call. */
function hasToolUse(content: unknown): boolean {
  let blocks = content;
  // DuckDB types a heterogeneous `content` column (text vs block arrays) as JSON.
  if (typeof blocks === 'string' && blocks.trimStart().startsWith('[')) {
    try { blocks = JSON.parse(blocks) as unknown; } catch { return false; }
  }
  return Array.isArray(blocks) && blocks.some(
    (b) => typeof b === 'object' && b !== null && (b as AnyRecord)['type'] === 'tool_use',
  );
}

export class ClaudeCodeConnector extends BaseFileConnector {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  readonly capabilities: ConnectorCapabilities = {
    tokenFields: ['promptTokens', 'completionTokens', 'cacheCreationTokens', 'cacheReadTokens', 'thinkingTokens'],
    costCategories: ['input', 'output', 'cache_creation', 'cache_read', 'thinking'],
    supportsRepoAttribution: true,
    sources: ['ndjson'],
  };

  constructor(
    pricing: PricingService,
    meta: MetaStore,
    fileReader: DuckDBFileReader,
    private readonly folderMatcher: IWorkspaceFolderMatcher,
    fsWatcher?: IFsWatcher,
    logger?: Logger,
  ) {
    super(pricing, meta, fileReader, fsWatcher, logger);
  }

  protected async discover(): Promise<{ globs: string[]; allowedRoots: string[]; searchedDirs: string[] }> {
    const dirs = await locateClaudeCodeLogDirs();
    /* c8 ignore next */
    if (dirs.length === 0) return { globs: [], allowedRoots: [], searchedDirs: [] };

    /* c8 ignore start */
    this.logPaths = dirs;
    // Use forward slashes for DuckDB glob compatibility on Windows.
    const globs = dirs.map((d) => path.join(d, '**', '*.jsonl').replace(/\\/g, '/'));
    return { globs, allowedRoots: dirs, searchedDirs: dirs };
    /* c8 ignore stop */
  }

  mapRow(row: AnyRecord, ctx: ParseContext): UsageEvent | null {
    if (row['type'] !== 'assistant') return null;

    const msg   = (row['message']  as AnyRecord | undefined) ?? row;
    const usage = (msg['usage']    as AnyRecord | undefined) ?? (row['usage'] as AnyRecord | undefined);
    if (!usage) return null;

    const model = String(
      (msg as AnyRecord)['model'] ??
      row['model'] ??
      (msg as AnyRecord)['gen_ai.request.model'] ??
      row['gen_ai.request.model'] ?? '',
    );
    if (!model || model === SYNTHETIC_MODEL) return null;

    const prompt        = num(usage['input_tokens']  ?? usage['prompt_tokens']);
    const completion    = num(usage['output_tokens'] ?? usage['completion_tokens']);
    const cacheCreation = num(usage['cache_creation_input_tokens']);
    const cacheRead     = num(usage['cache_read_input_tokens']);
    const thinking      = num(usage['thinking_tokens'] ?? usage['output_thinking_tokens']);
    const ts            = parseTimestamp({ ...row, ...msg });
    if (ts === undefined) return null;

    const tokens: TokenBreakdown = {
      ...(prompt        !== undefined ? { prompt }        : {}),
      ...(completion    !== undefined ? { completion }    : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
      ...(cacheRead     !== undefined ? { cacheRead }     : {}),
      ...(thinking      !== undefined ? { thinking }      : {}),
    };
    // A line that used no tokens in any category has nothing to count.
    if (Object.values(tokens).every((n) => n === 0)) return null;

    const priced = this.price(model, tokens, ctx);

    // Surface comes from the line itself: sub-agent (sidechain) turns and turns
    // that call tools are agent work, plain replies are chat. An explicit
    // ctx.surface still overrides.
    const surface: Surface =
      ctx.surface ?? (row['isSidechain'] === true || hasToolUse(msg['content']) ? 'agent' : 'chat');

    const sessionId  = typeof row['sessionId'] === 'string' ? row['sessionId'] : undefined;
    const sessionKey = sessionId ? sessionId.slice(-8) : 'cc';
    // Claude Code records the session's working directory per line; match that
    // against the open workspace folders for per-repo attribution in multi-root
    // workspaces. (sessionId is a random UUID and can't identify the folder.)
    const cwd = typeof row['cwd'] === 'string' ? row['cwd'] : undefined;
    const resolvedRepo = cwd ? this.folderMatcher.resolve(cwd) : undefined;
    // cwd is recorded in the log line itself, so it stays valid for backfill;
    // the ctx fallback is the active-editor heuristic and only applies to
    // live rows (see ParseContext.liveThresholdMs). `attribution` qualifies
    // `repo`; the branch is the line's own `gitBranch` (authoritative, valid
    // for backfill too) and only falls back to the live-gated heuristic when
    // the line carries none.
    const live = ctx.liveThresholdMs !== undefined && ts >= ctx.liveThresholdMs;
    const repo = resolvedRepo ?? (live ? ctx.repo : undefined);
    const lineBranch = typeof row['gitBranch'] === 'string' && row['gitBranch'] ? row['gitBranch'] : undefined;
    const attribution = resolvedRepo !== undefined ? ('authoritative' as const)
      : repo !== undefined ? ('heuristic' as const)
      : lineBranch !== undefined ? ('authoritative' as const) : undefined;
    const branch = lineBranch ?? (live ? ctx.branch : undefined);
    // Session logs carry no language; it is always the live-gated
    // active-editor heuristic.
    const language = live ? ctx.language : undefined;

    // One API message is logged as several lines (one per content block) that
    // share `message.id` + `requestId` and repeat/accumulate the same usage, so
    // that pair identifies the message: re-ingests and streaming duplicates
    // collapse onto one row, and a resumed session replaying history under a
    // new sessionId does not double-count (hence no sessionKey in this id).
    // Lines without a message id fall back to a per-line uuid/requestId, which
    // keeps two same-ms turns from colliding on the composite id.
    const messageId = typeof msg['id'] === 'string' && msg['id'] ? msg['id'] : undefined;
    const requestId = typeof row['requestId'] === 'string' && row['requestId'] ? row['requestId'] : undefined;
    const uniq = (typeof row['uuid'] === 'string' && row['uuid']) || requestId || '';
    const id = messageId !== undefined
      ? `claude-code:${messageId}${requestId ? `:${requestId}` : ''}`
      : `claude-code:${sessionKey}:${ts}:${model}${uniq ? `:${uniq}` : ''}`;

    return {
      id,
      ts,
      modelId: model,
      surface,
      source:  'claude-code',
      ...(prompt        !== undefined ? { promptTokens:        prompt }        : {}),
      ...(completion    !== undefined ? { completionTokens:    completion }    : {}),
      ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
      ...(cacheRead     !== undefined ? { cacheReadTokens:     cacheRead }     : {}),
      ...(thinking      !== undefined ? { thinkingTokens:      thinking }      : {}),
      credits: priced.credits,
      cost: priced.cost,
      estimated: true,
      ...(repo        !== undefined ? { repo }        : {}),
      ...(attribution !== undefined ? { attribution } : {}),
      ...(branch      !== undefined ? { branch }      : {}),
      ...(language    !== undefined ? { language }    : {}),
      ...(priced.costByCategory !== undefined ? { costByCategory: priced.costByCategory } : {}),
    };
  }

  /**
   * Cost for a message: exact per-token pricing when the price feed knows the
   * model, else an estimate from the bundled Claude list prices — never the
   * Copilot credit multiplier, which has nothing to do with what Anthropic
   * bills. Models with neither cost 0. `credits` stays the Copilot-equivalent
   * weight behind the credits metric. All Claude Code costs are log-derived,
   * hence `estimated`.
   */
  private price(
    model: string,
    tokens: TokenBreakdown,
    ctx: ParseContext,
  ): { credits: number; cost: number; costByCategory?: UsageEvent['costByCategory'] } {
    const credits = resolveMultiplier(model, undefined, ctx.manifest);
    const tokenCost =
      priceTokens(model, tokens, ctx.tokenPrices) ??
      priceTokens(model, tokens, CLAUDE_FALLBACK_TOKEN_PRICES);
    const byCategory = tokenCost?.byCategory;
    return {
      credits,
      cost: tokenCost?.total ?? 0,
      ...(byCategory && Object.keys(byCategory).length > 0 ? { costByCategory: byCategory } : {}),
    };
  }

  /**
   * Collapse two lines of one streamed message. Usage only grows as the stream
   * progresses, so keep the per-field maximum and re-price from it. The message
   * is agent work if any of its lines called a tool.
   */
  protected override mergeDuplicate(kept: UsageEvent, incoming: UsageEvent, ctx: ParseContext): UsageEvent {
    const max = (a?: number, b?: number): number | undefined =>
      a === undefined ? b : b === undefined ? a : Math.max(a, b);
    const prompt        = max(kept.promptTokens,        incoming.promptTokens);
    const completion    = max(kept.completionTokens,    incoming.completionTokens);
    const cacheCreation = max(kept.cacheCreationTokens, incoming.cacheCreationTokens);
    const cacheRead     = max(kept.cacheReadTokens,     incoming.cacheReadTokens);
    const thinking      = max(kept.thinkingTokens,      incoming.thinkingTokens);
    const tokens: TokenBreakdown = {
      ...(prompt        !== undefined ? { prompt }        : {}),
      ...(completion    !== undefined ? { completion }    : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
      ...(cacheRead     !== undefined ? { cacheRead }     : {}),
      ...(thinking      !== undefined ? { thinking }      : {}),
    };
    const priced = this.price(kept.modelId, tokens, ctx);
    const merged: UsageEvent = {
      ...kept,
      ts: Math.max(kept.ts, incoming.ts),
      surface: kept.surface === 'agent' || incoming.surface === 'agent' ? 'agent' : kept.surface,
      ...(prompt        !== undefined ? { promptTokens:        prompt }        : {}),
      ...(completion    !== undefined ? { completionTokens:    completion }    : {}),
      ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
      ...(cacheRead     !== undefined ? { cacheReadTokens:     cacheRead }     : {}),
      ...(thinking      !== undefined ? { thinkingTokens:      thinking }      : {}),
      credits: priced.credits,
      cost: priced.cost,
    };
    if (priced.costByCategory !== undefined) merged.costByCategory = priced.costByCategory;
    else delete merged.costByCategory;
    return merged;
  }
  /* c8 ignore next */
}
