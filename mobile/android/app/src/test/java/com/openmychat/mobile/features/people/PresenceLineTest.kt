package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.UserStatus
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class PresenceLineTest {

    private val zone = ZoneId.of("Asia/Almaty") // UTC+5
    private val now = ZonedDateTime.of(2026, 10, 2, 18, 0, 0, 0, zone)

    private fun line(status: UserStatus, lastSeen: String?) = PresenceLine.of(status, lastSeen, now)

    @Test
    fun liveStatusesWinOverLastSeen() {
        assertEquals(PresenceLine.Online, line(UserStatus.ONLINE, "2026-10-01T09:00:00.000Z"))
        assertEquals(PresenceLine.Away, line(UserStatus.AWAY, null))
        assertEquals(PresenceLine.DoNotDisturb, line(UserStatus.DND, null))
    }

    @Test
    fun offlineTodayShowsTheLocalTime() {
        // 09:32 UTC = 14:32 в Алматы.
        assertEquals(PresenceLine.SeenToday("14:32"), line(UserStatus.OFFLINE, "2026-10-02T09:32:00.000Z"))
    }

    @Test
    fun offlineYesterdayShowsYesterday() {
        assertEquals(PresenceLine.SeenYesterday("23:10"), line(UserStatus.OFFLINE, "2026-10-01T18:10:00.000Z"))
    }

    @Test
    fun olderDatesShowDayAndShortMonth() {
        assertEquals(PresenceLine.SeenOn("12 сент."), line(UserStatus.OFFLINE, "2026-09-12T08:00:00.000Z"))
        assertEquals(PresenceLine.SeenOn("3 мая 2025"), line(UserStatus.OFFLINE, "2025-05-03T08:00:00.000Z"))
    }

    @Test
    fun sqliteTimestampsAreUtcToo() {
        assertEquals(PresenceLine.SeenToday("14:32"), line(UserStatus.OFFLINE, "2026-10-02 09:32:00"))
    }

    @Test
    fun unknownOrFutureLastSeenFallsBackToOffline() {
        assertEquals(PresenceLine.Offline, line(UserStatus.OFFLINE, null))
        assertEquals(PresenceLine.Offline, line(UserStatus.OFFLINE, "garbage"))
        assertEquals(PresenceLine.Offline, line(UserStatus.OFFLINE, "2027-01-01T00:00:00.000Z"))
    }
}
