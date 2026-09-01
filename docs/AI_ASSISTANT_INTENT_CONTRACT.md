# Android Assistant hand-off contract

Ledgr accepts Android App Actions through a `ledgr://assistant` deep link. The
payload is untrusted input and must be parsed with `parseAssistantIntent`.

Supported actions:

- `open_ask_ai`
- `open_scanner`
- `record_payment`
- `record_expense`
- `record_receipt`
- `add_capital`

Accounting actions produce a draft with `requiresConfirmation: true`; they must
be shown in the normal review flow and must never be posted directly from an
external intent. API keys, account IDs, balances, and book data are not valid
intent fields. The app must require unlock before displaying or applying a
draft. Missing/ambiguous party roles are resolved inside Ledgr and preserve the
original request while asking a clarification question.

Example:

`ledgr://assistant?action=record_payment&amount=100&currency=CAD&counterparty=Amit&date=2026-09-01`

Native Android App Actions and manifest/deep-link registration require an Expo
development build (they are not available in Expo Go). The JavaScript contract
is intentionally usable before that native registration is shipped.
