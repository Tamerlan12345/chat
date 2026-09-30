import XCTest
@testable import CentyChat

final class EditWindowTests: XCTestCase {
    
    func testMessageWithinWindowCanBeEditedAndDeleted() {
        let now = Date()
        let tenMinutesAgo = now.addingTimeInterval(-10 * 60)
        
        let canEdit = ValidationRules.canEditOrDelete(
            createdAt: tenMinutesAgo,
            windowMinutesStr: "60",
            isSuperAdmin: false,
            action: .edit,
            currentTime: now
        )
        
        let canDelete = ValidationRules.canEditOrDelete(
            createdAt: tenMinutesAgo,
            windowMinutesStr: "60",
            isSuperAdmin: false,
            action: .delete,
            currentTime: now
        )
        
        XCTAssertTrue(canEdit, "Сообщение создано 10 минут назад при окне 60 минут — правка должна быть разрешена")
        XCTAssertTrue(canDelete, "Сообщение создано 10 минут назад при окне 60 минут — удаление должно быть разрешено")
    }
    
    func testMessageOutsideWindowCannotBeEditedOrDeleted() {
        let now = Date()
        let seventyMinutesAgo = now.addingTimeInterval(-70 * 60)
        
        let canEdit = ValidationRules.canEditOrDelete(
            createdAt: seventyMinutesAgo,
            windowMinutesStr: "60",
            isSuperAdmin: false,
            action: .edit,
            currentTime: now
        )
        
        let canDelete = ValidationRules.canEditOrDelete(
            createdAt: seventyMinutesAgo,
            windowMinutesStr: "60",
            isSuperAdmin: false,
            action: .delete,
            currentTime: now
        )
        
        XCTAssertFalse(canEdit, "Сообщение старше 60 минут — правка запрещена")
        XCTAssertFalse(canDelete, "Сообщение старше 60 минут — удаление запрещено")
    }
    
    func testDisabledWindowMinusOne() {
        let now = Date()
        let fiveSecondsAgo = now.addingTimeInterval(-5)
        
        let canEdit = ValidationRules.canEditOrDelete(
            createdAt: fiveSecondsAgo,
            windowMinutesStr: "-1",
            isSuperAdmin: false,
            action: .edit,
            currentTime: now
        )
        
        XCTAssertFalse(canEdit, "Окно -1 означает, что действие полностью выключено на сервере")
    }
    
    func testUnlimitedWindowZero() {
        let now = Date()
        let oneYearAgo = now.addingTimeInterval(-365 * 24 * 3600)
        
        let canEdit = ValidationRules.canEditOrDelete(
            createdAt: oneYearAgo,
            windowMinutesStr: "0",
            isSuperAdmin: false,
            action: .edit,
            currentTime: now
        )
        
        XCTAssertTrue(canEdit, "Окно 0 означает отсутствие ограничений по времени")
    }
    
    func testSuperAdminCanAlwaysDeleteAnyMessage() {
        let now = Date()
        let fiveDaysAgo = now.addingTimeInterval(-5 * 24 * 3600)
        
        let canDelete = ValidationRules.canEditOrDelete(
            createdAt: fiveDaysAgo,
            windowMinutesStr: "60",
            isSuperAdmin: true,
            action: .delete,
            currentTime: now
        )
        
        XCTAssertTrue(canDelete, "Суперадминистратор-модератор всегда может удалять любые сообщения")
    }
}
