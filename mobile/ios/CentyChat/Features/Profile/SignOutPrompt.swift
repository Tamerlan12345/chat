import Foundation

/// The sign-out question (`copy-ru.md` §1): always asked (final review M3), the unsent line first,
/// a blank line, then the body.
enum SignOutPrompt {
    static func message(unsent: Int?) -> String {
        guard let line = UnsentNotice.text(unsent) else { return AppCopy.signOutBody }
        return line + "\n\n" + AppCopy.signOutBody
    }

    /// The count the user agreed to is not the count that would be deleted now: ask again. Fewer is
    /// not a surprise (they went out meanwhile); an unknown count before was already said.
    static func needsAnotherLook(shown: Int?, now: Int?) -> Bool {
        guard let shown else { return false }
        guard let now else { return true }
        return now > shown
    }
}
