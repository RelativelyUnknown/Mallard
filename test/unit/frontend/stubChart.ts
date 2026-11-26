/**
 * Test helpers for the ECharts stub installed by test/unit/setup/jsdom.cjs.
 * The stub keeps the option from the latest setOption() call on the chart
 * instance; these helpers expose it (and the instance lifecycle) so chart
 * tests can assert on the real option objects and tooltip output.
 */

export interface StubDatum {
  value?: number;
  itemStyle?: { color?: string; opacity?: number };
}

export interface StubSeries {
  type?: string;
  name?: string;
  /** Plain numbers, or `{ value, itemStyle }` objects (most bar charts). */
  data?: Array<number | StubDatum | { name: string; value: number }>;
  links?: Array<{ source: string; target: string; value: number }>;
  itemStyle?: { color?: string };
  lineStyle?: { type?: string; color?: string };
  markLine?: { data?: Array<{ yAxis?: number }> };
}

export interface StubAxis {
  data?: string[];
  axisLabel?: { color?: (value: string) => string | undefined };
}

export interface StubOption {
  animation?: boolean;
  tooltip?: { formatter?: (params: unknown) => string };
  xAxis?: StubAxis;
  yAxis?: StubAxis;
  legend?: { show?: boolean };
  series?: StubSeries[];
}

export interface StubChart {
  _lastOption: StubOption | null;
  setOption(option: StubOption, opts?: Record<string, unknown>): void;
  on(event: string, cb: (params: unknown) => void): void;
  dispose(): void;
}

/** The stub chart instance behind a mounted chart handle. */
export function chartOf(handle: unknown): StubChart {
  return (handle as { chart: StubChart }).chart;
}

/** The option most recently passed to setOption on a mounted chart. */
export function lastOption(handle: unknown): StubOption {
  const option = chartOf(handle)._lastOption;
  if (!option) throw new Error('chart has no rendered option');
  return option;
}

/** The plotted numbers of a series, whether its data are bare numbers or `{ value }` objects. */
export function seriesValues(series: StubSeries): number[] {
  return (series.data ?? []).map((d) => (typeof d === 'number' ? d : (d.value ?? NaN)));
}

/** The tooltip formatter of the most recently rendered option. */
export function tooltipOf(handle: unknown): (params: unknown) => string {
  const fmt = lastOption(handle).tooltip?.formatter;
  if (typeof fmt !== 'function') throw new Error('chart option has no tooltip formatter');
  return fmt;
}

export interface RecordedChart {
  instance: StubChart;
  disposed: boolean;
  /** Handlers registered with chart.on(), by event name. */
  handlers: Map<string, Array<(params: unknown) => void>>;
  /** Every setOption call: the option and the options argument. */
  setOptionCalls: Array<{ option: StubOption; opts: Record<string, unknown> | undefined }>;
  /** Invoke the handlers registered for `event`, as ECharts would. */
  emit(event: string, params: unknown): void;
}

interface EchartsStubModule {
  init(el: unknown, theme?: unknown, opts?: unknown): StubChart;
}

/**
 * Runs `fn` with echarts.init() wrapped so every chart instance created is
 * recorded: its registered event handlers, setOption arguments, and whether it
 * was disposed. Unlike the stock stub, chart.on() does NOT fire immediately —
 * the test emits events itself, so it can tell a handler that was re-attached
 * after reinit() from one that was not.
 */
export function recordCharts<T>(fn: (created: RecordedChart[]) => T): T {
  const stub = (require.cache['__echarts_stub__'] as unknown as { exports: EchartsStubModule }).exports;
  const original = stub.init;
  const created: RecordedChart[] = [];
  stub.init = (el, theme, opts) => {
    const instance = original(el, theme, opts);
    const record: RecordedChart = {
      instance,
      disposed: false,
      handlers: new Map(),
      setOptionCalls: [],
      emit(event, params) {
        for (const cb of record.handlers.get(event) ?? []) cb(params);
      },
    };
    const originalSetOption = instance.setOption.bind(instance);
    instance.setOption = (option, setOpts) => {
      record.setOptionCalls.push({ option, opts: setOpts });
      originalSetOption(option, setOpts);
    };
    instance.on = (event, cb) => {
      record.handlers.set(event, [...(record.handlers.get(event) ?? []), cb]);
    };
    const originalDispose = instance.dispose.bind(instance);
    instance.dispose = () => {
      record.disposed = true;
      originalDispose();
    };
    created.push(record);
    return instance;
  };
  try {
    return fn(created);
  } finally {
    stub.init = original;
  }
}
