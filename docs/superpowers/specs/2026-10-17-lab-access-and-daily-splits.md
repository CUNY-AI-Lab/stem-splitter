# CUNY Lab access and daily splitter allowances

Policy requested October 17, 2026:

- Any account with current CUNY AI Lab Admission membership can sign in and use the personal STEM Splitter workspace. Local app suspension and current Admission expiry/revocation still apply. Course enrollment gates course features only.
- An active participant in the configured STEM course receives 15 split reservations per UTC day, across browsers and courses.
- Other signed-in CUNY AI Lab members, including app instructors and administrators, receive five per UTC day.
- A server-issued guest browser session receives three per UTC day. A Turnstile challenge does not increase that cap.
- Successful and in-progress runs use a slot. Failed and cancelled work releases it. Duplicate idempotency retries do not use another slot.
- Preserve existing abuse-attempt controls, input-duration limits, ownership, and provider billing. These are application run counts, not monetary accounting.

The current STEM course participant is the source of the student tier. Course membership lookups may identify that tier but cannot block an admitted Lab member's personal workspace when the course service is unavailable. Explicit course work continues to require current Admission course access.

Verification must exercise a CUNY member with no STEM course enrollment through personal sign-in and a split reservation, a current course student through the 15-run tier, instructors/administrators/other members through the five-run tier, and a guest's fourth reservation under concurrency. It must also confirm account readback reports the same current tier and reset time.
