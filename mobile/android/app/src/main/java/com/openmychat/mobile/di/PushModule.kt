package com.openmychat.mobile.di

import com.openmychat.mobile.data.push.FirebasePushTokenSource
import com.openmychat.mobile.data.push.PushTokenSource
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/** Push (decision P): the FCM token source; off when the build has no Firebase configuration. */
@Module
@InstallIn(SingletonComponent::class)
abstract class PushModule {
    @Binds abstract fun pushTokenSource(impl: FirebasePushTokenSource): PushTokenSource
}
