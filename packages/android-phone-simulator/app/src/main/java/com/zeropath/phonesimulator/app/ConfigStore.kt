package com.zeropath.phonesimulator.app

import android.content.Context

class ConfigStore(context: Context) {
  private val preferences = context.getSharedPreferences("zero_path_audio_test", Context.MODE_PRIVATE)

  var gatewayUrl: String
    get() = preferences.getString("gateway_url", "wss://192.168.1.2:8787/device")!!
    set(value) = preferences.edit().putString("gateway_url", value.trim()).apply()

  var allowInsecureGateway: Boolean
    get() = preferences.getBoolean("allow_insecure_gateway", false)
    set(value) = preferences.edit().putBoolean("allow_insecure_gateway", value).apply()

  var gatewayToken: String
    get() = preferences.getString("gateway_token", "")!!
    set(value) = preferences.edit().putString("gateway_token", value).apply()

  var esp32Address: String
    get() = preferences.getString("esp32_address", "")!!
    set(value) = preferences.edit().putString("esp32_address", value.trim()).apply()
}
