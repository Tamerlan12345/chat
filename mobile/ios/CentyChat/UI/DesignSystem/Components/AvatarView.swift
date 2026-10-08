import SwiftUI
import UIKit

/// Круглый аватар: фото сотрудника или инициалы на цвете из его имени, и статус присутствия.
///
/// Фото с сервера (`/api/users/<id>/avatar?v=…`) грузит `AvatarImageLoader` из окружения — с
/// токеном сеанса и кэшем; декодированное фото держит `AvatarImageMemo` сеанса, так что строка,
/// вернувшаяся на экран, показывает фото в первом же кадре (без мигания инициалов). Data URL
/// (старые ответы) декодируется один раз. Пока фото нет, не загрузилось или его сняли — инициалы.
///
/// The presence dot has a 2-pt ring in the surface colour behind it and pulses softly while the
/// person is typing (still with Reduce Motion).
public struct AvatarView: View {
    public let name: String
    public let avatarUrl: String?
    public var status: UserStatus? = nil
    public var size: CGFloat = 44
    /// The surface the avatar sits on: the ring around the presence dot.
    public var ringColor: Color = CentyColors.card
    public var isTyping: Bool = false

    @Environment(\.avatarLoader) private var loader
    @Environment(\.avatarMemo) private var memo
    @State private var photo: LoadedPhoto?

    public init(
        name: String,
        avatarUrl: String? = nil,
        status: UserStatus? = nil,
        size: CGFloat = 44,
        ringColor: Color = CentyColors.card,
        isTyping: Bool = false
    ) {
        self.name = name
        self.avatarUrl = avatarUrl
        self.status = status
        self.size = size
        self.ringColor = ringColor
        self.isTyping = isTyping
    }

    private struct LoadedPhoto {
        let url: URL
        let image: UIImage
    }

    private var remoteURL: URL? {
        loader?.url(for: avatarUrl, diameter: size)
    }

    /// `data:image/…;base64,…` — what servers without the link opt-in still send.
    private var inlineImage: UIImage? {
        guard let avatarUrl, avatarUrl.hasPrefix("data:image") else { return nil }
        if let memo { return memo.inlineImage(avatarUrl) }
        guard let comma = avatarUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(avatarUrl[avatarUrl.index(after: comma)...])) else {
            return nil
        }
        return UIImage(data: data)
    }

    /// The photo for this frame: loaded by this view, else already decoded for the session.
    private func currentImage(for url: URL?) -> UIImage? {
        if let inline = inlineImage { return inline }
        guard let url else { return nil }
        if let photo, photo.url == url { return photo.image }
        return memo?.image(for: url.absoluteString)
    }

    public var body: some View {
        let url = remoteURL
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let image = currentImage(for: url) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    initialsView
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())

            if let status {
                PresenceDot(status: status, size: max(10, size * 0.26), ringColor: ringColor, pulses: isTyping)
                    .offset(x: 1, y: 1)
            }
        }
        .task(id: url) {
            guard let url, let loader else {
                photo = nil
                return
            }
            guard photo?.url != url else { return }
            if let known = memo?.image(for: url.absoluteString) {
                photo = LoadedPhoto(url: url, image: known)
                return
            }
            let data = await loader.data(for: url)
            guard !Task.isCancelled else { return }
            // Decoded off the main thread, ready to draw.
            let image: UIImage? = await Task.detached(priority: .userInitiated) {
                data.flatMap { UIImage(data: $0)?.preparingForDisplay() ?? UIImage(data: $0) }
            }.value
            guard !Task.isCancelled else { return }
            if let image {
                memo?.store(image, for: url.absoluteString)
                photo = LoadedPhoto(url: url, image: image)
            } else {
                photo = nil
            }
        }
    }

    private var initialsView: some View {
        ZStack {
            AvatarPalette.color(for: name)
            Text(AvatarPalette.initials(of: name))
                // Glyph inside a fixed circle: sized with the circle, not with Dynamic Type.
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }
}

/// A channel's avatar: a slate tile with a `#` (a lock for a private channel).
struct ChannelAvatar: View {
    var isPrivate = false
    var size: CGFloat = 44

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
            .fill(CentyColors.channelSlate)
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: isPrivate ? "lock.fill" : "number")
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}

/// The presence dot: status colour with a ring in the surface colour; a soft pulse while typing.
struct PresenceDot: View {
    let status: UserStatus
    var size: CGFloat = 12
    var ringColor: Color = CentyColors.card
    var pulses = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(status.color)
            .frame(width: size, height: size)
            .padding(2)
            .background(Circle().fill(ringColor))
            .scaleEffect(pulses && pulse && !reduceMotion ? 1.18 : 1)
            .onChange(of: pulses, initial: true) { _, typing in
                guard typing, !reduceMotion else {
                    pulse = false
                    return
                }
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
            .accessibilityHidden(true)
    }
}

/// Цвет и инициалы аватара без фото — порт настольного `lib/avatar.mjs` (как Android
/// `AvatarPalette`), чтобы у человека был один цвет во всех клиентах (решение 2026-10-02).
enum AvatarPalette {
    /// Белый текст на каждом из этих цветов читается с контрастом не ниже 4.5:1.
    static let colors: [UInt32] = [0x2563EB, 0x7C3AED, 0x0E7490, 0x047857, 0xB45309, 0xBE185D, 0x4338CA, 0x475569]

    /// `hash = hash * 31 + charCode` over UTF-16 code units (as JavaScript), then the
    /// desktop's bit mixing, modulo the palette.
    static func colorHex(for name: String) -> UInt32 {
        var hash: UInt32 = 0
        for unit in name.utf16 {
            hash = hash &* 31 &+ UInt32(unit)
        }
        hash ^= hash >> 16
        hash = hash &* 0x45d9f3b
        hash ^= hash >> 16
        return colors[Int(hash % UInt32(colors.count))]
    }

    static func color(for name: String) -> Color {
        let hex = colorHex(for: name)
        return Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// «Фамилия Имя» → «ФИ»; a lowercase second word («Администратор системы») is not a name.
    static func initials(of name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return "?" }
        var initials = String(first)
        if words.count > 1, let second = words[1].first, second.isUppercase {
            initials.append(second)
        }
        return initials.uppercased()
    }
}

private struct AvatarLoaderKey: EnvironmentKey {
    static let defaultValue: AvatarImageLoader? = nil
}

extension EnvironmentValues {
    /// Loads server photos for every `AvatarView` below; without it avatars show initials.
    var avatarLoader: AvatarImageLoader? {
        get { self[AvatarLoaderKey.self] }
        set { self[AvatarLoaderKey.self] = newValue }
    }
}

#Preview("Avatars") {
    HStack(spacing: 16) {
        AvatarView(name: "Алиса Тестова", status: .online, size: 44)
        AvatarView(name: "Боб Тестов", status: .away, size: 44, isTyping: true)
        AvatarView(name: "Карина Смирнова", status: .dnd, size: 64)
        ChannelAvatar(size: 44)
        ChannelAvatar(isPrivate: true, size: 44)
    }
    .padding()
    .background(CentyColors.card)
}
