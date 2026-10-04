import SwiftUI

extension View {
    /// Content type for a password field. In UI-test processes the field uses `.oneTimeCode`
    /// instead, which never triggers the system «Save Password?» / strong-password sheets that
    /// would otherwise cover the screen under test.
    func passwordContent(_ type: UITextContentType) -> some View {
        textContentType(LaunchTestFixture.suppressesPasswordAutofill ? .oneTimeCode : type)
    }
}
