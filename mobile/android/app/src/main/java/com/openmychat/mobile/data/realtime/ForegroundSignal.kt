package com.openmychat.mobile.data.realtime

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

/** The process came to the foreground (ProcessLifecycleOwner ON_START); screens use it to catch up. */
@Singleton
class ForegroundSignal @Inject constructor() {
    private val _entered = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val entered: SharedFlow<Unit> = _entered.asSharedFlow()

    fun enter() {
        _entered.tryEmit(Unit)
    }
}
