import { TaskSchema } from './task.schema';

// BE-1 ("schemi e indici") declared indexes on User, ServiceCredential and
// Report but none on Task, and nothing since noticed: an index is invisible
// until it is missing under load, and no unit test had a reason to look. This
// one exists so that deleting an index is a deliberate act with a failing
// test attached, the same way the unique index on ServiceCredential is
// load-bearing for "reconnecting a provider replaces the record".
describe('TaskSchema indexes', () => {
  const declared = TaskSchema.indexes().map(([fields]) => fields);

  it('covers the batch-completion tally by batchId and status', () => {
    // maybeEmitBatchCompleted runs three countDocuments on this shape at the
    // end of every single job.
    expect(declared).toContainEqual({ batchId: 1, status: 1 });
  });

  it('covers the dashboard list query by owner and recency', () => {
    // findAllForUser: find({ userId }).sort({ createdAt: -1 }) — the sort
    // direction is part of the index, not an afterthought, or it is done in
    // memory over every Task the user has ever created.
    expect(declared).toContainEqual({ userId: 1, createdAt: -1 });
  });
});
