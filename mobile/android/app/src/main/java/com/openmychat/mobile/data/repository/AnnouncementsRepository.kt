package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.data.model.Announcement
import javax.inject.Inject
import javax.inject.Singleton

interface AnnouncementsRepository {
    suspend fun announcements(): List<Announcement>
    suspend fun acknowledge(id: Long)
}

@Singleton
class DefaultAnnouncementsRepository @Inject constructor(
    private val apiClient: ApiClient
) : AnnouncementsRepository {
    override suspend fun announcements(): List<Announcement> = apiClient.getAnnouncements()
    override suspend fun acknowledge(id: Long) {
        apiClient.acknowledgeAnnouncement(id)
    }
}
