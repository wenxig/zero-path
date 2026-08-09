package com.zeropath.phonesimulator

import android.app.Application
import com.zeropath.phonesimulator.app.AppContainer

class ZeroPathApplication : Application() {
  lateinit var container: AppContainer
    private set

  override fun onCreate() {
    super.onCreate()
    container = AppContainer(this)
  }
}
