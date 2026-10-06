import Foundation

/// Staggered appearance of list items (search sections, «Отделы» children).
enum Stagger {
    static func departmentRow(index: Int, reduceMotion: Bool) -> TimeInterval {
        0
    }

    static func searchItem(index: Int, reduceMotion: Bool) -> TimeInterval {
        0
    }
}
