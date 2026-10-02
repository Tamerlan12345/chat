package com.openmychat.mobile.features.people

/**
 * Нормализация текста для поиска сотрудников: регистр не важен, «ё» равна «е». Свёртка идёт по
 * одному символу и сохраняет длину строки, поэтому найденный фрагмент подсвечивается по тем же
 * индексам в исходном имени.
 */
object SearchText {
    fun normalize(text: String): String {
        val out = CharArray(text.length)
        for (i in text.indices) {
            val c = text[i].lowercaseChar()
            out[i] = if (c == 'ё') 'е' else c
        }
        return String(out)
    }

    /** Слова запроса: «Иван  Петров» → [иван, петров]. Все слова должны найтись (И). */
    fun tokens(query: String): List<String> =
        normalize(query).split(WHITESPACE).filter { it.isNotEmpty() }

    fun digits(text: String): String = text.filter { it in '0'..'9' }

    /** Слово похоже на кусок номера телефона: цифры и знаки «+ ( ) - .». */
    fun isPhoneLike(token: String): Boolean =
        token.any { it in '0'..'9' } && token.all { it in '0'..'9' || it in PHONE_PUNCTUATION }

    private val WHITESPACE = Regex("\\s+")
    private const val PHONE_PUNCTUATION = "+()-."
}

/** Чем меньше, тем выше в выдаче (спецификация «People surface», раздел Ranking). */
enum class MatchRank {
    /** Начало фамилии или имени (первые два слова ФИО). */
    NAME_PREFIX,

    /** Начало другого слова ФИО (отчество, вторая часть двойной фамилии). */
    OTHER_TOKEN_PREFIX,

    /** Подстрока в ФИО. */
    NAME_SUBSTRING,

    /** Логин, должность, отдел, внутренний номер, телефон, почта. */
    OTHER_FIELD
}

data class PersonMatch(
    val person: Person,
    val rank: MatchRank,
    /** Найденные части ФИО (индексы в `person.fullName`) для подсветки; пусто, если нашлось в другом поле. */
    val highlights: List<IntRange> = emptyList()
)

object PeopleSearch {

    /** Совпадение одного человека со всем запросом или null. Пустой запрос не совпадает ни с кем. */
    fun match(person: Person, query: String): PersonMatch? {
        val tokens = SearchText.tokens(query)
        if (tokens.isEmpty()) return null
        return match(person, tokens)
    }

    /**
     * Выдача по запросу: ранг, внутри ранга — сначала те, кто в сети (и «отошёл»), затем по
     * алфавиту. Пустой запрос — все по алфавиту.
     */
    fun rank(people: List<Person>, query: String): List<PersonMatch> {
        val tokens = SearchText.tokens(query)
        if (tokens.isEmpty()) {
            return people.sortedWith(compareBy(NameOrder) { it.fullName }).map { PersonMatch(it, MatchRank.NAME_PREFIX) }
        }
        return people.mapNotNull { match(it, tokens) }.sortedWith(RESULT_ORDER)
    }

    /** Подходит ли человек под запрос (для фильтра дерева отделов). */
    fun matches(person: Person, query: String): Boolean {
        val tokens = SearchText.tokens(query)
        return tokens.isEmpty() || match(person, tokens) != null
    }

    private val RESULT_ORDER: Comparator<PersonMatch> =
        compareBy<PersonMatch> { it.rank }
            .thenBy { if (it.person.status.isReachable) 0 else 1 }
            .thenBy(NameOrder) { it.person.fullName }

    private fun match(person: Person, tokens: List<String>): PersonMatch? {
        val name = SearchText.normalize(person.fullName)
        val words = wordsOf(name)
        var worst = MatchRank.NAME_PREFIX
        val highlights = ArrayList<IntRange>()
        for (token in tokens) {
            val found = matchToken(person, name, words, token, highlights) ?: return null
            if (found > worst) worst = found
        }
        return PersonMatch(person, worst, highlights.sortedBy { it.first }.distinct())
    }

    private fun matchToken(
        person: Person,
        name: String,
        words: List<Word>,
        token: String,
        highlights: MutableList<IntRange>
    ): MatchRank? {
        words.firstOrNull { it.text.startsWith(token) }?.let { word ->
            highlights += word.start until word.start + token.length
            return if (word.index <= 1 && !word.isPart) MatchRank.NAME_PREFIX else MatchRank.OTHER_TOKEN_PREFIX
        }
        val at = name.indexOf(token)
        if (at >= 0) {
            highlights += at until at + token.length
            return MatchRank.NAME_SUBSTRING
        }
        return if (matchesOtherField(person, token)) MatchRank.OTHER_FIELD else null
    }

    private fun matchesOtherField(person: Person, token: String): Boolean {
        val plain = listOf(person.username, person.jobTitle, person.departmentName, person.extension, person.email)
        if (plain.any { it != null && SearchText.normalize(it).contains(token) }) return true
        val phone = person.phone ?: return false
        if (!SearchText.isPhoneLike(token)) return false
        val digits = SearchText.digits(token)
        return digits.length >= 3 && SearchText.digits(phone).contains(digits)
    }

    private class Word(val text: String, val start: Int, val index: Int, val isPart: Boolean)

    /** Слова ФИО с позициями; части двойной фамилии («Петрова-Водкина») — отдельно, как «другие слова». */
    private fun wordsOf(name: String): List<Word> {
        val words = ArrayList<Word>()
        var index = 0
        var i = 0
        while (i < name.length) {
            if (name[i].isWhitespace()) {
                i++
                continue
            }
            val start = i
            while (i < name.length && !name[i].isWhitespace()) i++
            val word = name.substring(start, i)
            words += Word(word, start, index, isPart = false)
            var partStart = 0
            word.forEachIndexed { offset, c ->
                if (c == '-' && offset + 1 < word.length) {
                    partStart = offset + 1
                    words += Word(word.substring(partStart), start + partStart, index, isPart = true)
                }
            }
            index++
        }
        return words
    }
}

/**
 * Алфавитный порядок имён, одинаковый на JVM и устройстве: сначала кириллица (А–Я, «ё» как «е»),
 * затем латиница, затем цифры и прочее. Пробел раньше любой буквы: «Иванов Борис» < «Иванова Алла».
 */
object NameOrder : Comparator<String> {
    override fun compare(a: String, b: String): Int {
        val x = SearchText.normalize(a.trim())
        val y = SearchText.normalize(b.trim())
        val n = minOf(x.length, y.length)
        for (i in 0 until n) {
            val diff = weight(x[i]) - weight(y[i])
            if (diff != 0) return diff
        }
        return x.length - y.length
    }

    /** Группа первой буквы для разделов списка: 0 — кириллица, 1 — латиница, 2 — прочее. */
    fun script(c: Char): Int {
        val n = SearchText.normalize(c.toString())[0]
        return when (n) {
            in 'а'..'я' -> 0
            in 'a'..'z' -> 1
            else -> 2
        }
    }

    private fun weight(c: Char): Int = when (c) {
        in 'а'..'я' -> 1_000 + (c - 'а')
        in 'a'..'z' -> 2_000 + (c - 'a')
        in '0'..'9' -> 3_000 + (c - '0')
        else -> if (c.isWhitespace() || c == '-' || c == '.') 0 else 4_000 + c.code
    }
}
