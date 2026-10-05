package com.openmychat.mobile.di

import com.openmychat.mobile.data.repository.AccountRepository
import com.openmychat.mobile.data.repository.DefaultAccountRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/** Registration, deletion, reports and blocks; its own module so UI tests can script the server. */
@Module
@InstallIn(SingletonComponent::class)
abstract class AccountModule {
    @Binds abstract fun accountRepository(impl: DefaultAccountRepository): AccountRepository
}
