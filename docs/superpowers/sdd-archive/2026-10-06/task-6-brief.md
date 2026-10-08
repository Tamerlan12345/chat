### Task 6: Android — anti-"AI-generated" polish pass (plan Task 23)

Worktree `m-android`. Depends on Task 5.
Apply the design brief section «Anti-"AI-generated" polish pass» to every Android screen (borders only where specified, spacing rhythm, three type steps per row, empty states with next-step actions, copy naming its objects, badge rules, chat refinements, grouped native lists in Profile/Announcements, announcement importance dot). Also fix the Task 17 deferred minors (bar return timing chat→inbox, R8 frame drops on bar slide, stale motion table, ChatBubble blank lines, `barVisiblePx` written in layout), QA D8 (ask POST_NOTIFICATIONS after login with a short explanation) and throttle typing frames (≤1 per 3 s while typing, stop frame on idle/send). Functionality must not change.
Acceptance: before/after screenshots of every screen in light, dark and font 2.0; existing UI tests green; independent design finish-review by the controller.

