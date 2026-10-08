import SwiftUI
import UIKit

/// The call stage (design brief component 14): dark full screen whatever the theme (like the
/// desktop call panels), the avatar with a breathing ring while it rings, the name, the state or
/// the timer, a live five-bar level of the peer's voice, 64-pt round controls with their labels, the
/// end button in `danger-fill`; a microphone problem explains itself with «Открыть настройки».
public struct CallView: View {
    @Environment(CallStore.self) private var calls
    @Environment(\.dynamicTypeSize) private var typeSize

    public init() {}

    public var body: some View {
        ZStack {
            CentyColors.callBackground.ignoresSafeArea()
            if let call = calls.activeCall {
                stage(call)
            }
        }
        .environment(\.colorScheme, .dark)
        .accessibilityIdentifier("call-stage")
    }

    private func stage(_ call: CallSession) -> some View {
        let ringing = call.state == .calling || call.state == .ringing || call.state == .connecting
        return VStack(spacing: 0) {
            Spacer(minLength: 24)
            VStack(spacing: 16) {
                ZStack {
                    BreathingRing(isActive: ringing, diameter: 156)
                    AvatarView(name: call.peerName, avatarUrl: call.peerAvatar, size: 120, ringColor: CentyColors.callBackground)
                }
                .accessibilityHidden(true)
                Text(call.peerName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                if call.state == .active {
                    Text(call.formattedDuration)
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(Color.white.opacity(0.85))
                        .contentTransition(.numericText())
                        .accessibilityLabel(Text("Длительность \(call.formattedDuration)"))
                    LevelMeter(level: calls.peerLevel)
                        .padding(.top, 4)
                } else {
                    Text(call.state.descriptionRu)
                        .font(.body)
                        .foregroundStyle(Color.white.opacity(0.7))
                }
            }
            .padding(.horizontal, 24)

            if let audioError = calls.callAudioError {
                audioProblem(audioError, call: call)
                    .padding(.top, 24)
                    .padding(.horizontal, 24)
            }

            Spacer(minLength: 32)

            if call.state == .ringing && call.direction == .incoming {
                incomingControls
            } else {
                activeControls(call)
            }
        }
        .padding(.bottom, 32)
    }

    private func audioProblem(_ message: String, call: CallSession) -> some View {
        VStack(spacing: 12) {
            Label(message, systemImage: "mic.slash.fill")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.white)
                .accessibilityLabel(Text("Ошибка звука: \(message)"))
            HStack(spacing: 12) {
                if call.state == .active || call.state == .connecting {
                    Button("Повторить") {
                        Task { await calls.retryAudioForActiveCall() }
                    }
                    .buttonStyle(CentyLinkButtonStyle(tint: Color.white))
                    .accessibilityLabel("Повторить подключение звука")
                    .accessibilityHint("Пробует заново подключить звук текущего звонка")
                }
                if calls.callAudioRequiresMicrophonePermission {
                    Button("Открыть настройки") {
                        guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(settingsURL)
                    }
                    .buttonStyle(CentyLinkButtonStyle(tint: Color.white))
                    .accessibilityLabel("Открыть настройки микрофона")
                    .accessibilityHint("Открывает настройки приложения, чтобы разрешить доступ к микрофону")
                    .accessibilityIdentifier("call-open-settings")
                }
            }
        }
        .padding(16)
        .frame(maxWidth: 420)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CentyColors.callControl))
        .accessibilityElement(children: .contain)
    }

    // MARK: - Controls

    private var incomingControls: some View {
        HStack(spacing: 64) {
            CallControlButton(title: "Отклонить", systemImage: "phone.down.fill", fill: CentyColors.dangerFill, identifier: "call-reject") {
                Task { await calls.rejectIncomingCall() }
            }
            CallControlButton(title: "Принять", systemImage: "phone.fill", fill: CentyColors.successFill, identifier: "call-answer") {
                Task { await calls.answerIncomingCall() }
            }
        }
    }

    private func activeControls(_ call: CallSession) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 20)) : AnyLayout(HStackLayout(spacing: 32))
        return layout {
            CallControlButton(
                title: call.isMuted ? "Микрофон выкл." : "Микрофон",
                systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill",
                isOn: call.isMuted,
                identifier: "call-mute"
            ) {
                calls.toggleMute()
            }
            .disabled(call.state != .active)
            CallControlButton(
                title: "Динамик",
                systemImage: call.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.fill",
                isOn: call.isSpeakerOn,
                identifier: "call-speaker"
            ) {
                calls.toggleSpeaker()
            }
            CallControlButton(title: "Завершить", systemImage: "phone.down.fill", fill: CentyColors.dangerFill, identifier: "call-end") {
                Task { await calls.endCall() }
            }
        }
    }
}

#if DEBUG
#Preview("Звонок") {
    let container = AppContainer.preview()
    container.calls.activeCall = CallSession(peerId: 2, peerName: "Боб Тестов", state: .calling, direction: .outgoing)
    return CallView()
        .previewEnvironment(container)
}
#endif
