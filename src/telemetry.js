import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import fs from 'fs';
import path from 'path';

class JsonlSpanExporter {
  constructor(filePath) {
    this.filePath = filePath;
  }
  export(spans, resultCallback) {
    try {
      const lines = spans.map(span => {
        return JSON.stringify({
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          name: span.name,
          startTime: span.startTime,
          endTime: span.endTime,
          durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
          status: span.status,
          attributes: span.attributes || {}
        });
      }).join('\n') + '\n';
      
      fs.appendFileSync(this.filePath, lines);
      resultCallback({ code: 0 }); // ExportResultCode.SUCCESS
    } catch (error) {
      console.error('[krusch-context-mcp] Failed to export span to JSONL:', error);
      resultCallback({ code: 1, error }); // ExportResultCode.FAILED
    }
  }
  shutdown() { return Promise.resolve(); }
}

export function initTracing(logFilePath) {
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const exporter = new JsonlSpanExporter(logFilePath);
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  });

  provider.register();
  
  return provider;
}
