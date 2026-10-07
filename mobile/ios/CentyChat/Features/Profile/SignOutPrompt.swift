import Foundation

/// The sign-out question.
enum SignOutPrompt {
    static func message(unsent: Int?) -> String {
        UnsentNotice.text(unsent) ?? ""
    }

    static func needsAnotherLook(shown: Int?, now: Int?) -> Bool {
        false
    }
}
