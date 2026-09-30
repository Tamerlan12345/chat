import SwiftUI
import UIKit

/// Тактильный отклик (Haptic Feedback) CentyChat
public enum CentyHaptics: Sendable {
    
    @MainActor
    public static func light() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.prepare()
        generator.impactOccurred()
    }
    
    @MainActor
    public static func medium() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred()
    }
    
    @MainActor
    public static func success() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
    }
    
    @MainActor
    public static func warning() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.warning)
    }
    
    @MainActor
    public static func error() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.error)
    }
    
    /// Виброотклик для побудки (Wake Buzzer)
    @MainActor
    public static func wakeBuzzer() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.error)
    }
}
