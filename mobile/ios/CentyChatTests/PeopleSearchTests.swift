import Foundation
import XCTest
@testable import CentyChat

/// Normalisation and ranking of the people search (spec «People surface», Ranking).
/// Same cases as Android `PeopleSearchTest`, so both clients rank identically.
final class PeopleSearchTests: XCTestCase {
    private func person(
        _ id: Int64,
        _ name: String,
        job: String? = nil,
        department: String? = nil,
        extension: String? = nil,
        phone: String? = nil,
        email: String? = nil,
        username: String? = nil,
        status: UserStatus = .offline
    ) -> Person {
        Person(
            id: id,
            fullName: name,
            username: username ?? "user\(id)",
            jobTitle: job,
            departmentName: department,
            extension: `extension`,
            phone: phone,
            email: email,
            status: status
        )
    }

    // MARK: - Normalisation

    func testNormalisationFoldsCaseAndYoAndKeepsTheLength() {
        XCTAssertEqual(SearchText.normalize("Ёлка ПЕТРОВА"), "елка петрова")
        XCTAssertEqual(SearchText.normalize("Ёлка ПЕТРОВА").count, "Ёлка ПЕТРОВА".count)
    }

    func testTokensSplitOnWhitespaceAndDropEmpties() {
        XCTAssertEqual(SearchText.tokens("  Иван   Петров "), ["иван", "петров"])
        XCTAssertEqual(SearchText.tokens("   "), [])
    }

    func testPhoneQueriesAreRecognisedWithSpacesAndPunctuation() {
        XCTAssertTrue(SearchText.isPhoneQuery("+7 (702) 303-30-30"))
        XCTAssertFalse(SearchText.isPhoneQuery("12"))
        XCTAssertFalse(SearchText.isPhoneQuery("отдел 214"))
        XCTAssertEqual(SearchText.digits("+7 (700) 123-45-00"), "77001234500")
    }

    // MARK: - Ranks

    func testSurnameOrFirstNamePrefixRanksFirst() {
        let ivanov = person(1, "Иванов Пётр")
        XCTAssertEqual(PeopleSearch.match(ivanov, query: "иван")?.rank, .namePrefix)
        XCTAssertEqual(PeopleSearch.match(ivanov, query: "петр")?.rank, .namePrefix)
    }

    func testAnotherNameTokenPrefixRanksSecond() {
        XCTAssertEqual(PeopleSearch.match(person(1, "Иванов Пётр Сергеевич"), query: "серг")?.rank, .otherTokenPrefix)
        XCTAssertEqual(
            PeopleSearch.match(person(2, "Петрова-Водкина Анна"), query: "водк")?.rank,
            .otherTokenPrefix,
            "The second part of a double surname is «another word»"
        )
    }

    func testSubstringOfTheNameRanksThird() {
        XCTAssertEqual(PeopleSearch.match(person(1, "Иванов Пётр"), query: "ано")?.rank, .nameSubstring)
    }

    func testOtherFieldsRankLast() {
        let ivanov = person(
            1, "Иванов Пётр", job: "Бухгалтер", department: "Финансы", extension: "214",
            phone: "+7 (700) 123-45-00", email: "p.ivanov@example.com", username: "pivanov"
        )
        for query in ["бухг", "финан", "214", "123-45", "7001234500", "example.com", "pivan"] {
            XCTAssertEqual(PeopleSearch.match(ivanov, query: query)?.rank, .otherField, query)
        }
    }

    func testPhoneMatchIgnoresPunctuation() {
        let ivanov = person(1, "Иванов Пётр", phone: "+7 (700) 123-45-00")
        XCTAssertNotNil(PeopleSearch.match(ivanov, query: "(700) 123"))
        XCTAssertNil(PeopleSearch.match(ivanov, query: "8-700"))
    }

    func testAPhoneTypedWithSpacesIsFound() {
        let abramova = person(1, "Абрамова Мария", phone: "+7 702 303 30 30")
        XCTAssertEqual(PeopleSearch.match(abramova, query: "+7 702 303 30 30")?.rank, .otherField)
        XCTAssertEqual(PeopleSearch.match(abramova, query: "702 303")?.rank, .otherField)
        XCTAssertNil(PeopleSearch.match(abramova, query: "702 999"))
    }

    func testMultiWordQueriesNeedEveryTokenAndTakeTheWorstRank() {
        let ivan = person(1, "Иванов Пётр", department: "Финансы")
        let other = person(2, "Иванова Анна", department: "Склад")
        XCTAssertNotNil(PeopleSearch.match(ivan, query: "иван фин"))
        XCTAssertNil(PeopleSearch.match(other, query: "иван фин"))
        XCTAssertEqual(PeopleSearch.match(ivan, query: "иван фин")?.rank, .otherField)
    }

    func testYoAndCaseDoNotMatter() {
        XCTAssertEqual(PeopleSearch.match(person(1, "Семёнов Алексей"), query: "СЕМЕН")?.rank, .namePrefix)
        XCTAssertEqual(PeopleSearch.match(person(2, "Семенов Алексей"), query: "семён")?.rank, .namePrefix)
    }

    func testRankingOrdersByRankThenOnlineThenAlphabet() {
        let people = [
            person(1, "Петров Иван"),
            person(2, "Иванова Анна"),
            person(3, "Иванов Борис", status: .online),
            person(4, "Сидоров Олег", job: "Иванович-консультант"),
            person(5, "Иванова Алла", status: .away),
            person(6, "Марьиванова Ольга"),
        ]
        XCTAssertEqual(PeopleSearch.rank(people, query: "иван").map(\.person.id), [3, 5, 2, 1, 6, 4])
    }

    func testDoNotDisturbIsNotOnlineForRanking() {
        let people = [person(1, "Иванов Борис", status: .dnd), person(2, "Иванов Андрей")]
        XCTAssertEqual(PeopleSearch.rank(people, query: "иванов").map(\.person.id), [2, 1])
    }

    // MARK: - Highlights

    func testHighlightsCoverTheMatchedPartOfTheName() {
        XCTAssertEqual(PeopleSearch.match(person(1, "Петров Иван"), query: "иван")?.highlights, [7..<11])
        XCTAssertEqual(PeopleSearch.match(person(2, "Марьиванова Ольга"), query: "иван")?.highlights, [4..<8])
        XCTAssertEqual(PeopleSearch.match(person(3, "Сидоров Олег", job: "Иванович"), query: "иван")?.highlights, [])
    }

    func testFieldMatchesAreHighlightedWhereTheyWereFound() throws {
        let match = try XCTUnwrap(PeopleSearch.match(
            person(1, "Иванов Пётр", job: "Бухгалтер", department: "Финансы", extension: "214"),
            query: "финан 21"
        ))
        XCTAssertEqual(match.subtitleHighlights, [12..<17])
        XCTAssertEqual(match.extensionHighlights, [0..<2])
    }

    func testAnEmptyQueryMatchesNobodyButBrowsingListsEveryoneAlphabetically() {
        let people = [person(1, "Яковлев Ян"), person(2, "Абрамова Анна")]
        XCTAssertNil(PeopleSearch.match(people[0], query: "  "))
        XCTAssertEqual(PeopleSearch.rank(people, query: "").map(\.person.id), [2, 1])
    }

    // MARK: - Alphabet

    func testNameOrderIsCyrillicThenLatinThenDigitsAndSpaceBeforeLetters() {
        XCTAssertTrue(NameOrder.precedes("Иванов Борис", "Иванова Алла"))
        XCTAssertTrue(NameOrder.precedes("Ёлкин Пётр", "Жуков Олег"), "«Ё» sorts as «Е»")
        XCTAssertTrue(NameOrder.precedes("Яковлев Ян", "Adams John"))
        XCTAssertTrue(NameOrder.precedes("Zed Zed", "007 Bond"))
    }
}
