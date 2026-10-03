import AVFoundation
import Foundation

/// Owns activation and deactivation of the platform call audio session.
public final class AudioSessionManager: @unchecked Sendable {
    public static let shared = AudioSessionManager()

    private let lock = NSLock()
    private var isConfigured = false

    private init() {}

    /// Configures a call session only after the caller has granted microphone access.
    /// Failures are surfaced to the relay so an unaudible call is never marked active.
    public func activateForCall() throws {
        lock.lock()
        defer { lock.unlock() }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .defaultToSpeaker]
        )
        try session.setPreferredSampleRate(AudioRelayEngine.sampleRate)
        try session.setPreferredIOBufferDuration(0.032)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        isConfigured = true
    }

    /// Compatibility entry point for existing callers. New call code uses `activateForCall()`.
    public func configureForCall() {
        try? activateForCall()
    }

    public func setSpeaker(enabled: Bool) {
        lock.lock()
        defer { lock.unlock() }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.overrideOutputAudioPort(enabled ? .speaker : .none)
        } catch {
            // Changing the preferred route is recoverable; keep the active call running.
        }
    }

    public func endCallSession() {
        lock.lock()
        defer { lock.unlock() }

        guard isConfigured else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.overrideOutputAudioPort(.none)
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            isConfigured = false
        } catch {
            // The operating system may already have deactivated the session after interruption.
            isConfigured = false
        }
    }
}
