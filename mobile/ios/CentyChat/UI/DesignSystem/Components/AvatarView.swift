import SwiftUI
import UIKit

/// Круглый аватар: фото сотрудника или инициалы на цвете из его имени, и статус присутствия.
///
/// Фото с сервера (`/api/users/<id>/avatar?v=…`) грузит `AvatarImageLoader` из окружения — с
/// токеном сеанса и кэшем; data URL (старые ответы) показывается сразу. Пока фото нет, не
/// загрузилось или его сняли — инициалы.
public struct AvatarView: View {
    public let name: String
    public let avatarUrl: String?
    public var status: UserStatus? = nil
    public var size: CGFloat = 44

    @Environment(\.avatarLoader) private var loader
    @State private var photo: LoadedPhoto?

    public init(name: String, avatarUrl: String? = nil, status: UserStatus? = nil, size: CGFloat = 44) {
        self.name = name
        self.avatarUrl = avatarUrl
        self.status = status
        self.size = size
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
        guard let avatarUrl, avatarUrl.hasPrefix("data:image"),
              let comma = avatarUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(avatarUrl[avatarUrl.index(after: comma)...])) else {
            return nil
        }
        return UIImage(data: data)
    }

    public var body: some View {
        let url = remoteURL
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let inline = inlineImage {
                    Image(uiImage: inline)
                        .resizable()
                        .scaledToFill()
                } else if let photo, photo.url == url {
                    Image(uiImage: photo.image)
                        .resizable()
                        .scaledToFill()
                } else {
                    initialsView
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())

            if let status = status {
                StatusBadge(status: status, size: max(10, size * 0.28))
                    .offset(x: 2, y: 2)
            }
        }
        .task(id: url) {
            guard let url, let loader else {
                photo = nil
                return
            }
            guard photo?.url != url else { return }
            let data = await loader.data(for: url)
            guard !Task.isCancelled else { return }
            if let data, let image = UIImage(data: data) {
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
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundColor(.white)
        }
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
