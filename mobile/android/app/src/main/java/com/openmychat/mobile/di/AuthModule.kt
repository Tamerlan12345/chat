package com.openmychat.mobile.di

import com.openmychat.mobile.data.repository.AuthRepository
import com.openmychat.mobile.data.repository.DefaultAuthRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/** Sign-in, kept apart from the other repositories so UI tests can script server answers. */
@Module
@InstallIn(SingletonComponent::class)
abstract class AuthModule {
    @Binds abstract fun authRepository(impl: DefaultAuthRepository): AuthRepository
}
