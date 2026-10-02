package com.openmychat.mobile

import com.openmychat.mobile.di.LoginModule
import com.openmychat.mobile.features.auth.LoginPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import javax.inject.Singleton

/** A fresh, in-memory "last login name" per test instead of the device's preferences. */
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [LoginModule::class])
object TestLoginModule {
    @Provides
    @Singleton
    fun provideLoginPreferences(): LoginPreferences = object : LoginPreferences {
        override var lastUsername: String? = null
    }
}
