const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateBucketCommand: jest.fn((input: unknown) => ({
    __type: 'CreateBucketCommand',
    input,
  })),
  PutBucketLifecycleConfigurationCommand: jest.fn((input: unknown) => ({
    __type: 'PutBucketLifecycleConfigurationCommand',
    input,
  })),
  PutObjectCommand: jest.fn((input: unknown) => ({
    __type: 'PutObjectCommand',
    input,
  })),
}));

import { ReportArtifactStorageService } from './report-artifact-storage.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    REPORTS_BUCKET_NAME: 'code-guardian-reports',
    S3_REGION: 'us-east-1',
    S3_ENDPOINT: 'http://minio:9000',
    S3_FORCE_PATH_STYLE: true,
    S3_ACCESS_KEY_ID: 'minioadmin',
    S3_SECRET_ACCESS_KEY: 'minioadmin',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) };
}

describe('ReportArtifactStorageService', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('onModuleInit', () => {
    it('creates the bucket and applies the 30-day lifecycle rule', async () => {
      mockSend.mockResolvedValue({});
      const service = new ReportArtifactStorageService(makeConfig() as never);

      await service.onModuleInit();

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenNthCalledWith(1, {
        __type: 'CreateBucketCommand',
        input: { Bucket: 'code-guardian-reports' },
      });
      expect(mockSend).toHaveBeenNthCalledWith(2, {
        __type: 'PutBucketLifecycleConfigurationCommand',
        input: {
          Bucket: 'code-guardian-reports',
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'expire-report-artifacts-30d',
                Status: 'Enabled',
                Filter: {},
                Expiration: { Days: 30 },
              },
            ],
          },
        },
      });
    });

    it('still applies the lifecycle rule when the bucket already exists', async () => {
      const alreadyExists = Object.assign(new Error('exists'), {
        name: 'BucketAlreadyOwnedByYou',
      });
      mockSend.mockRejectedValueOnce(alreadyExists).mockResolvedValueOnce({});
      const service = new ReportArtifactStorageService(makeConfig() as never);

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('swallows an unexpected bucket-creation failure rather than crashing startup', async () => {
      mockSend.mockRejectedValueOnce(new Error('network down'));
      const service = new ReportArtifactStorageService(makeConfig() as never);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      // Never gets to the lifecycle call — a real failure (not "already
      // exists") stops here, unlike the idempotent-exists case above.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('swallows a lifecycle-configuration failure too', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('not supported'));
      const service = new ReportArtifactStorageService(makeConfig() as never);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('putReportArtifact', () => {
    it('uploads keyed by report id with the pdf content type', async () => {
      mockSend.mockResolvedValue({});
      const service = new ReportArtifactStorageService(makeConfig() as never);
      const pdf = Buffer.from('%PDF-1.4 fake');

      await service.putReportArtifact('report1', pdf);

      expect(mockSend).toHaveBeenCalledWith({
        __type: 'PutObjectCommand',
        input: {
          Bucket: 'code-guardian-reports',
          Key: 'report1',
          Body: pdf,
          ContentType: 'application/pdf',
        },
      });
    });
  });
});
