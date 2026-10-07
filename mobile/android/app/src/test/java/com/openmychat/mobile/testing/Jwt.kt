package com.openmychat.mobile.testing

import java.util.Base64

/** A JWT-shaped session token whose payload names [userId], as the server issues them (`userId` claim). */
fun jwt(userId: Long, jti: String = "j$userId"): String {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    val header = encoder.encodeToString("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
    val payload = encoder.encodeToString("""{"userId":$userId,"jti":"$jti"}""".toByteArray())
    return "$header.$payload.signature"
}
