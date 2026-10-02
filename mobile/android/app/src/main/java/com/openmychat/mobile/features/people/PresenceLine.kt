package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.UserStatus
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Строка статуса в карточке сотрудника: живой статус, а для не в сети — когда был(а) в сети
 * («сегодня в 14:32», «вчера в 09:10», «12 сент.»). Тексты собирает экран из ресурсов.
 */
sealed interface PresenceLine {
    data object Online : PresenceLine
    data object Away : PresenceLine
    data object DoNotDisturb : PresenceLine

    /** Не в сети, время последнего визита неизвестно. */
    data object Offline : PresenceLine
    data class SeenToday(val time: String) : PresenceLine
    data class SeenYesterday(val time: String) : PresenceLine
    data class SeenOn(val date: String) : PresenceLine

    companion object {
        fun of(status: UserStatus, lastSeen: String?, now: ZonedDateTime = ZonedDateTime.now()): PresenceLine =
            when (status) {
                UserStatus.ONLINE -> Online
                UserStatus.AWAY -> Away
                UserStatus.DND -> DoNotDisturb
                UserStatus.OFFLINE -> lastSeen(lastSeen, now)
            }

        private fun lastSeen(raw: String?, now: ZonedDateTime): PresenceLine {
            val instant = parse(raw) ?: return Offline
            // Часы устройства и сервера расходятся на секунды; «будущее» дальше минуты — мусор.
            if (instant.isAfter(now.toInstant().plusSeconds(60))) return Offline
            val seen = instant.atZone(now.zone)
            val days = ChronoUnit.DAYS.between(seen.toLocalDate(), now.toLocalDate())
            val time = seen.format(TIME)
            return when {
                days <= 0L -> SeenToday(time)
                days == 1L -> SeenYesterday(time)
                seen.year == now.year -> SeenOn("${seen.dayOfMonth} ${MONTHS[seen.monthValue - 1]}")
                else -> SeenOn("${seen.dayOfMonth} ${MONTHS[seen.monthValue - 1]} ${seen.year}")
            }
        }

        /** ISO-8601 из API («…T09:32:00.000Z») или время SQLite («2026-10-02 09:32:00», UTC). */
        internal fun parse(raw: String?): Instant? {
            val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return runCatching { Instant.parse(value) }.getOrNull()
                ?: runCatching { LocalDateTime.parse(value, SQLITE).toInstant(ZoneOffset.UTC) }.getOrNull()
        }

        private val TIME = DateTimeFormatter.ofPattern("HH:mm")
        private val SQLITE = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

        /** Родительный падеж с принятыми сокращениями: «12 сент.», «3 мая». */
        private val MONTHS = listOf(
            "янв.", "февр.", "марта", "апр.", "мая", "июня",
            "июля", "авг.", "сент.", "окт.", "нояб.", "дек."
        )
    }
}
