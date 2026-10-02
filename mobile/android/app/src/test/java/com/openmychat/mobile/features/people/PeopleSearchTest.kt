package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.UserStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PeopleSearchTest {

    private fun person(
        id: Long,
        name: String,
        job: String? = null,
        department: String? = null,
        extension: String? = null,
        phone: String? = null,
        email: String? = null,
        username: String = "user$id",
        status: UserStatus = UserStatus.OFFLINE
    ) = Person(
        id = id,
        fullName = name,
        username = username,
        jobTitle = job,
        departmentName = department,
        extension = extension,
        phone = phone,
        email = email,
        status = status
    )

    @Test
    fun normalisationFoldsCaseAndYo() {
        assertEquals("елка петрова", SearchText.normalize("Ёлка ПЕТРОВА"))
        // Длина сохраняется: подсветка считается по индексам исходной строки.
        assertEquals("Ёлка ПЕТРОВА".length, SearchText.normalize("Ёлка ПЕТРОВА").length)
    }

    @Test
    fun tokensSplitOnWhitespaceAndDropEmpties() {
        assertEquals(listOf("иван", "петров"), SearchText.tokens("  Иван   Петров "))
        assertEquals(emptyList<String>(), SearchText.tokens("   "))
    }

    @Test
    fun surnameOrFirstNamePrefixRanksFirst() {
        val ivanov = person(1, "Иванов Пётр")
        assertEquals(MatchRank.NAME_PREFIX, PeopleSearch.match(ivanov, "иван")?.rank)
        assertEquals(MatchRank.NAME_PREFIX, PeopleSearch.match(ivanov, "петр")?.rank)
    }

    @Test
    fun anotherNameTokenPrefixRanksSecond() {
        val person = person(1, "Иванов Пётр Сергеевич")
        assertEquals(MatchRank.OTHER_TOKEN_PREFIX, PeopleSearch.match(person, "серг")?.rank)
    }

    @Test
    fun substringOfTheNameRanksThird() {
        val person = person(1, "Иванов Пётр")
        assertEquals(MatchRank.NAME_SUBSTRING, PeopleSearch.match(person, "ано")?.rank)
    }

    @Test
    fun otherFieldsRankLast() {
        val person = person(
            1, "Иванов Пётр", job = "Бухгалтер", department = "Финансы", extension = "214",
            phone = "+7 (727) 244-77-00", email = "p.ivanov@cic.kz", username = "pivanov"
        )
        listOf("бухг", "финан", "214", "244-77", "7272447700", "cic.kz", "pivan").forEach { query ->
            assertEquals(query, MatchRank.OTHER_FIELD, PeopleSearch.match(person, query)?.rank)
        }
    }

    @Test
    fun phoneMatchIgnoresPunctuation() {
        val person = person(1, "Иванов Пётр", phone = "+7 (727) 244-77-00")
        assertTrue(PeopleSearch.match(person, "(727) 244") != null)
        assertNull(PeopleSearch.match(person, "8-727"))
    }

    @Test
    fun multiWordQueriesNeedEveryToken() {
        val ivan = person(1, "Иванов Пётр", department = "Финансы")
        val other = person(2, "Иванова Анна", department = "Склад")
        assertTrue(PeopleSearch.match(ivan, "иван фин") != null)
        assertNull(PeopleSearch.match(other, "иван фин"))
        // Ранг человека — худший из рангов слов запроса.
        assertEquals(MatchRank.OTHER_FIELD, PeopleSearch.match(ivan, "иван фин")?.rank)
    }

    @Test
    fun yoAndCaseDoNotMatter() {
        val person = person(1, "Семёнов Алексей")
        assertEquals(MatchRank.NAME_PREFIX, PeopleSearch.match(person, "СЕМЕН")?.rank)
    }

    @Test
    fun rankingOrdersByRankThenOnlineThenAlphabet() {
        val people = listOf(
            person(1, "Петров Иван"), // имя начинается с запроса (2-е слово)
            person(2, "Иванова Анна"), // фамилия, не в сети
            person(3, "Иванов Борис", status = UserStatus.ONLINE), // фамилия, в сети
            person(4, "Сидоров Олег", job = "Иванович-консультант"), // другое поле
            person(5, "Иванова Алла", status = UserStatus.AWAY), // фамилия, отошла (считается «в сети»)
            person(6, "Марьиванова Ольга") // подстрока
        )
        val ids = PeopleSearch.rank(people, "иван").map { it.person.id }
        assertEquals(listOf(3L, 5L, 2L, 1L, 6L, 4L), ids)
    }

    @Test
    fun highlightsCoverTheMatchedPartOfTheName() {
        val match = PeopleSearch.match(person(1, "Петров Иван"), "иван")!!
        assertEquals(listOf(7 until 11), match.highlights)
        val substring = PeopleSearch.match(person(2, "Марьиванова Ольга"), "иван")!!
        assertEquals(listOf(4 until 8), substring.highlights)
        val field = PeopleSearch.match(person(3, "Сидоров Олег", job = "Иванович"), "иван")!!
        assertEquals(emptyList<IntRange>(), field.highlights)
    }

    @Test
    fun anEmptyQueryMatchesNobodyInRankButEveryoneInBrowse() {
        val people = listOf(person(1, "Яковлев Ян"), person(2, "Абрамова Анна"))
        assertNull(PeopleSearch.match(people[0], "  "))
        assertEquals(listOf(2L, 1L), PeopleSearch.rank(people, "").map { it.person.id })
    }
}
