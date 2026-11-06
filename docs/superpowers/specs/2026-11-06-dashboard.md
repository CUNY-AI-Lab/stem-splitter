# Dashboard and personal Listening Guy instructions

The November 6 user direction replaces the separate Settings and Instructor
Console entries with Dashboard. Dashboard contains Account and Listening Guy
views using the existing account.html and teacher.html routes. Every admitted
CAIL user can manage their own Personal instructions and revision history.
Class instructions and rosters still require the exact current capabilities.
Guest sessions have no Dashboard or saved personal instructions.

Personal amendments are keyed to the authenticated subject, never a supplied
account ID. Writes require the current actor expectation, a revision and a change
note. Changes and resets retain immutable history and invalidate only that
subject's cached Personal guides. Guide caches are also subject-scoped. Class
work continues to use class instructions; guest work uses the base prompt.
Neither app-wide legacy instructions nor another person's personal amendment
may influence these contexts. The fixed prompt remains read only.

The user also requested a compact, balanced subtitle with their existing copy,
consistent Share with and Run splitter controls, stable screen geometry when
returning to the window, and accurate readable account activity. Revalidation
must retain authentication/role checks while avoiding routine hide/show layout
jumps. Account creation time must not be called first use, and recorded browser
observations must not be presented as a complete activity history.

Additive personal-prompt storage is necessary for the new user-authorized
capability. No role grant, credential, provider, paid invocation or remote
record mutation is part of local implementation/testing. Existing release
authority remains direct Dev then production Workers after applicable checks.
