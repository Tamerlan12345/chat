import Foundation
import AVFoundation

/// Менеджер аудиосессии iOS для VoIP звонков CentyChat
public final class AudioSessionManager: @unchecked Sendable {
    public static let shared = AudioSessionManager()
    
    private let lock = NSLock()
    private var isConfigured = false
    
    private init() {}
    
    /// Настройка AVAudioSession для голосового вызова (PlayAndRecord, VoiceChat)
    public func configureForCall() {
        lock.lock()
        defer { lock.unlock() }
        
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
            try session.setPreferredSampleRate(AudioRelayEngine.sampleRate)
            try session.setPreferredIOBufferDuration(0.032) // 32 мс
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            isConfigured = true
        } catch {
            print("[AudioSessionManager] Error configuring audio session: \(error)")
        }
    }
    
    /// Переключение громкой связи (Speaker)
    public func setSpeaker(enabled: Bool) {
        lock.lock()
        defer { lock.unlock() }
        
        let session = AVAudioSession.sharedInstance()
        do {
            if enabled {
                try session.overrideOutputAudioPort(.speaker)
            } else {
                try session.overrideOutputAudioPort(.none)
            }
        } catch {
            print("[AudioSessionManager] Error toggling speaker: \(error)")
        }
    }
    
    /// Деактивация аудиосессии при завершении вызова
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
            print("[AudioSessionManager] Error ending audio session: \(error)")
        }
    }
}
