package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.core.network.ConnectionState
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge

/** How long the link must hold after a reconnect or foreground entry before data is reloaded. */
const val RESYNC_DEBOUNCE_MS = 1_000L

/**
 * One request per burst of "catch up now" causes: the link coming back (the first state is not a
 * reconnect) or the process reaching the foreground. Causes within [RESYNC_DEBOUNCE_MS] coalesce, and
 * nothing is requested if the link is down again by then (the next reconnect asks instead).
 */
@OptIn(FlowPreview::class)
fun StateFlow<ConnectionState>.resyncRequests(foreground: Flow<Unit>): Flow<Unit> =
    merge(
        map { it == ConnectionState.Connected }.distinctUntilChanged().drop(1).filter { it }.map { },
        foreground
    ).debounce(RESYNC_DEBOUNCE_MS).filter { value == ConnectionState.Connected }
