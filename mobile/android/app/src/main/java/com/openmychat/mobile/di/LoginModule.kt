package com.openmychat.mobile.di

import android.content.Context
import com.openmychat.mobile.features.auth.LoginPreferences
import com.openmychat.mobile.features.auth.SharedPreferencesLoginPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** Non-secret login conveniences (the last login name). Never holds a password or token. */
@Module
@InstallIn(SingletonComponent::class)
object LoginModule {
    @Provides
    @Singleton
    fun provideLoginPreferences(@ApplicationContext context: Context): LoginPreferences =
        SharedPreferencesLoginPreferences(
            context.getSharedPreferences(SharedPreferencesLoginPreferences.FILE_NAME, Context.MODE_PRIVATE)
        )
}
