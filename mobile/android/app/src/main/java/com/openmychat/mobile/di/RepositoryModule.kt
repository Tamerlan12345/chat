package com.openmychat.mobile.di

import com.openmychat.mobile.data.repository.AnnouncementsRepository
import com.openmychat.mobile.data.repository.ChatRepository
import com.openmychat.mobile.data.repository.DefaultAnnouncementsRepository
import com.openmychat.mobile.data.repository.DefaultChatRepository
import com.openmychat.mobile.data.repository.DefaultPeopleRepository
import com.openmychat.mobile.data.repository.DefaultProfileRepository
import com.openmychat.mobile.data.repository.DefaultRealtimeRepository
import com.openmychat.mobile.data.repository.DefaultSessionRepository
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.ProfileRepository
import com.openmychat.mobile.data.repository.RealtimeRepository
import com.openmychat.mobile.data.repository.SessionRepository
import com.openmychat.mobile.features.search.RecentsStore
import com.openmychat.mobile.features.search.SharedPreferencesRecentsStore
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {
    @Binds abstract fun sessionRepository(impl: DefaultSessionRepository): SessionRepository
    @Binds abstract fun chatRepository(impl: DefaultChatRepository): ChatRepository
    @Binds abstract fun announcementsRepository(impl: DefaultAnnouncementsRepository): AnnouncementsRepository
    @Binds abstract fun profileRepository(impl: DefaultProfileRepository): ProfileRepository
    @Binds abstract fun realtimeRepository(impl: DefaultRealtimeRepository): RealtimeRepository
    @Binds abstract fun peopleRepository(impl: DefaultPeopleRepository): PeopleRepository
    @Binds abstract fun recentsStore(impl: SharedPreferencesRecentsStore): RecentsStore
    @Binds abstract fun notificationSink(
        impl: com.openmychat.mobile.data.notifications.SystemNotificationSink
    ): com.openmychat.mobile.data.notifications.NotificationSink
}
