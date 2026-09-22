# Historical backfill adapters

`openclaw command-center backfill` loads one absolute, digest-pinned private
adapter. The adapter exports `createHistoricalBackfillAdapter(context)`. Its
source bytes are read once with `O_NOFOLLOW`, bounded to 2 MiB, verified against
the supplied SHA-256 digest, and imported from those verified bytes.

The context contains a cloned plan, mode, cloned OpenClaw configuration,
cancellation signal, and a frozen `commandCenter` owner. It never exposes raw
Command Center metadata.

An adapter implements:

- `readPage({ sourceKind, scope, after, limit })`
- `classify({ sourceKind, record, historicalBaseline })`
- `applyRecord({ backfillId, logicalOperationId, sourceKind, record, classification })`
- `reconcileRecord(...)` with the same record and classification as
  `applyRecord`, plus `recordDigest`
- `recordReceipt(receipt, authority)`
- for withdrawal: `inspectEffect`, `withdrawEffect`, and
  `reconcileWithdrawal`

The `commandCenter` owner provides:

- `resolveTopic({ topicName })`, which returns a result only for one exact
  active Topic with one Note Folder;
- `readNote({ topicId, noteFolderReferenceId, path })`, which reads exact Note
  evidence through the authoritative Note owner;
- `captureCommitment({ logicalOperationId, capture })`;
- `reconcileCommitment({ logicalOperationId, capture })`;
- `inspectEffect({ effectId })`;
- `withdrawEffect({ logicalOperationId, effectId, expectedRevision })`; and
- `reconcileWithdrawal(...)`.

The capture owner forces `historicalBaseline: true`. Completed and
knowledge-only records therefore remain quiet, while an uncertain record is
converted by the backfill owner to inferred provenance before dispatch.

Adapters must reconstruct the identical capture intent during reconciliation.
They must not dispatch a new mutation from `reconcileRecord`. Withdrawal is
revision-bound and preserves any effect whose revision changed or whose
evidence contains a later user decision.

Source selection and semantic classification remain private adapter
responsibilities. Tests in this public repository use fictional records only.
