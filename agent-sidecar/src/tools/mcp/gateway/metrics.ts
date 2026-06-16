import type { IMcpGatewayMetricSink, TMcpGatewayMetric } from './types.js';

const METRIC_BUFFER_MAX = 1_000;

export class McpGatewayMetricBuffer implements IMcpGatewayMetricSink {
  private readonly metrics: TMcpGatewayMetric[] = [];
  private listener: ((metric: TMcpGatewayMetric) => void) | null = null;
  private droppedCount = 0;

  emit(metric: TMcpGatewayMetric): void {
    if (this.listener) {
      this.listener(metric);
      return;
    }
    this.metrics.push(metric);
    if (this.metrics.length > METRIC_BUFFER_MAX) {
      this.metrics.shift();
      this.droppedCount += 1;
    }
  }

  setListener(listener: (metric: TMcpGatewayMetric) => void): void {
    this.listener = listener;
    while (this.metrics.length > 0) {
      const metric = this.metrics.shift();
      if (metric) {
        listener(metric);
      }
    }
    if (this.droppedCount > 0) {
      listener({ type: 'mcp_gateway.metric_buffer_dropped', droppedCount: this.droppedCount });
      this.droppedCount = 0;
    }
  }
}
