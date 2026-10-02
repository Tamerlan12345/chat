package com.openmychat.mobile

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.openmychat.mobile.core.network.ApiClient
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class CentyChatApp : Application(), SingletonImageLoader.Factory {

    @Inject lateinit var apiClient: ApiClient

    /** Avatars load through the app's OkHttp client (TLS policy, bearer only to the fixed server). */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { apiClient.imageHttpClient })) }
            .build()
}
