package com.openmychat.mobile.di

import android.content.Context
import com.openmychat.mobile.core.session.SessionManager
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Provides the fail-closed encrypted session store. Kept in its own module so instrumented tests
 * can replace it with an in-memory store via `@TestInstallIn`.
 */
@Module
@InstallIn(SingletonComponent::class)
object SessionModule {
    @Provides
    @Singleton
    fun provideSessionManager(@ApplicationContext context: Context): SessionManager = SessionManager(context)
}
