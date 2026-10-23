# Classroom usage and account matching

Every roster response begins with the instructor’s current Admission authority
and the current roster page. Supplemental app counters join only that page’s
opaque member identifiers to locally stored, previously verified account matches.
A match grants no course access and assigns no personal recording to a class.
Personal titles and conversation text remain within their existing access paths.

Successful course verification remembers the subject/member match. A scheduled
background batch checks at most six historical account/course pairs per invocation
through the existing five-second RPC boundary. Successful or denied checks defer
another background lookup for a day; unavailable accounts defer for five minutes
without clearing a prior verified match. Every disclosure still requires the fresh
Admission roster, so a remembered match cannot retain a removed member’s row.

Roster requests make no supplemental Admission calls for other accounts. If the
supplemental storage or aggregate query fails, the roster, assigned split counts,
pagination and class controls remain available with app usage marked temporarily
unavailable. Unmatched rows display “App usage pending” rather than zero activity
or an inferred first visit. Older accounts populate gradually through background
matching, including accounts with personal work predating this release.

Apply additive migration `0030-course-usage-accounts.sql` before the worker. It
creates only the identity-matching table and index; no enrollment, recording,
conversation or historical accounting row is rewritten.
