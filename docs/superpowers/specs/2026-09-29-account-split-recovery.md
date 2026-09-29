# CUNY Login and account-owned split recovery

Keep the existing visual design and use the page's compact, bordered button
style for CUNY Login, My account, and the account return link. Maintain keyboard
focus visibility and a minimum 44-pixel touch target.

The signed-in person's server-side ownership is the source of truth for the
Session Rack. A new browser, cleared storage, or blocked browser storage must
not lose discoverability of their retained splits. Fetch a bounded, paginated
list using the verified principal; never accept a client-selected owner. Keep
the legacy class-code mode unchanged and exclude unclaimed legacy records.

Retain the 30-day policy. Existing job endpoints remain responsible for notes,
labels, guide and audio authorization. Do not call browser-only chat archives or
Remixer layers account-saved work. Hiding a card is temporary, not deletion of
the server copy. Account outages must not masquerade as an empty saved list.

Acceptance covers desktop/mobile buttons, first visit and return from Account,
fresh-browser recovery, unavailable storage, pagination, list outage/retry,
other-person and anonymous denial, suspension, and discovery of a separately
reviewed ownership assignment. Fixtures do not prove live CUNY authentication,
real paid inference, legacy identity equivalence, or a completed migration.

No Railway mutation, production account reassignment, shared identity repair,
new schema, or deployment is part of this implementation.
