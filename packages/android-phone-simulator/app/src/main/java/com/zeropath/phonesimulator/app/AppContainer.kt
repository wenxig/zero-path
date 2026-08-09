package com.zeropath.phonesimulator.app

import android.content.Context
import com.zeropath.phonesimulator.audio.AudioTestController
import com.zeropath.phonesimulator.audio.SppAudioTransport
import com.zeropath.phonesimulator.remote.GatewayClient
import com.zeropath.phonesimulator.security.PinManager
import com.zeropath.phonesimulator.security.ShellExecutor
import java.util.concurrent.ExecutorService
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

class AppContainer(context: Context) {
  private val appContext = context.applicationContext
  val config = ConfigStore(appContext)
  val pinManager = PinManager(appContext)
  val shellExecutor = ShellExecutor(pinManager)
  val audioController = AudioTestController(appContext, SppAudioTransport(appContext))
  val commandExecutor: ExecutorService = ThreadPoolExecutor(
    2,
    2,
    0,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(32),
  )
  val gatewayClient = GatewayClient(appContext, audioController, pinManager, shellExecutor, commandExecutor)
}
