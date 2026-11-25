import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OneWindowBatch } from '../../core/one-window/types';
import { OneWindowBatchActions, OneWindowDeliveryDescription, OneWindowUploadStatus } from './OneWindowPage';

const batch: OneWindowBatch = { taskId: '1096d1f4-93e5-4e48-acad-121c49c1adcb', matterId: 'outdoor-advertising-approval', createdAt: 1,
  total: 1, partialCount: 0, fileName: 'old-workbook.xlsx', filePath: 'C:\\old-exports\\old-workbook.xlsx',
  uploadStatus: 'failed', uploadError: null, uploadedAt: null, objectKey: null };
const callbacks = { onView() {}, onFolder() {}, onRetry() {} };

describe('one-window record delivery presentation', () => {
  it('describes direct data sync and provides retry without Excel, attachments, folder actions or export permission', () => {
    const html = renderToStaticMarkup(<>
      <OneWindowDeliveryDescription deliveryMode="records" /><OneWindowDeliveryDescription deliveryMode="records" batches />
      <OneWindowUploadStatus batch={batch} deliveryMode="records" />
      <OneWindowBatchActions batch={batch} deliveryMode="records" allowExport={false} retrying="" {...callbacks} />
    </>);
    expect(html).toContain('直接同步至后台'); expect(html).toContain('同步需重试'); expect(html).toContain('重试同步'); expect(html).toContain('查看数据');
    expect(html).not.toMatch(/Excel|xlsx|附件|文件夹|导出|推送/);
  });

  it('distinguishes waiting, blocked and completed data instead of claiming an unfinished batch was uploaded', () => {
    expect(renderToStaticMarkup(<OneWindowUploadStatus batch={{ ...batch, uploadStatus: 'pending' }} deliveryMode="records" />)).toContain('等待同步');
    const failed = renderToStaticMarkup(<OneWindowUploadStatus batch={{ ...batch, uploadError: '<script>fixture-only</script>' }} deliveryMode="records" />);
    expect(failed).toContain('同步需重试'); expect(failed).toContain('&lt;script&gt;'); expect(failed).not.toContain('<script>');
    const completed = { ...batch, uploadStatus: 'uploaded' as const };
    expect(renderToStaticMarkup(<OneWindowUploadStatus batch={completed} deliveryMode="records" />)).toContain('已同步至后台');
    expect(renderToStaticMarkup(<OneWindowBatchActions batch={completed} deliveryMode="records" allowExport={false} retrying="" {...callbacks} />)).not.toContain('重试同步');
    expect(renderToStaticMarkup(<OneWindowBatchActions batch={{ ...batch, uploadStatus: 'pending' }} deliveryMode="records" allowExport={false} retrying={batch.taskId} {...callbacks} />)).toContain('同步中');
  });

  it('preserves the existing workbook UI when the delivery mode is workbook', () => {
    const html = renderToStaticMarkup(<>
      <OneWindowDeliveryDescription deliveryMode="workbook" /><OneWindowUploadStatus batch={batch} deliveryMode="workbook" />
      <OneWindowBatchActions batch={batch} deliveryMode="workbook" allowExport retrying="" {...callbacks} />
    </>);
    expect(html).toContain('生成 Excel'); expect(html).toContain('推送失败'); expect(html).toContain('打开文件夹'); expect(html).toContain('重新推送');
    expect(renderToStaticMarkup(<OneWindowDeliveryDescription />)).not.toContain('Excel');
  });
});
