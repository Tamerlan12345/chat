package com.openmychat.mobile.di

import javax.inject.Qualifier

/** Coroutine scope that lives as long as the process; used for realtime connection management. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class ApplicationScope
