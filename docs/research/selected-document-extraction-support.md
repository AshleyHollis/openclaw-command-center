# Selected-document extraction support

The bounded pilot supports UTF-8 plaintext invoices with a labelled invoice identifier and either an explicit payment phrase or a labelled amount using an ISO 4217 currency code. Supported identifier labels are `Invoice`, `Invoice number`, `Invoice no.`, and `Invoice #`. Supported amount labels are `Amount due`, `Total due`, and `Balance due`. Optional aliases cover account, supplier/payee, purpose/description, and an RFC 3339 due instant.

The pilot does not claim PDF OCR, arbitrary prose extraction, attachment parsing, model-based interpretation, quote classification, or general invoice understanding. Unsupported or ambiguous documents remain evidence only and the UI explicitly reports that no supported obligation was recognized.

The fictional evaluation corpus in `test/fixtures/selected-document-extraction-evaluation.json` contains six positive layouts and six negative/adversarial documents. The acceptance threshold is precision 1.0, recall at least 0.8, and expected-field accuracy at least 0.9. This is bounded local quality evidence for the declared plaintext format, not production evidence for mailboxes or arbitrary documents.
