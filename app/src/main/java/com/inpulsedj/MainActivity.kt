package com.inpulsedj

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.inpulsedj.ui.InpulseTheme
import com.inpulsedj.ui.MonitorScreen
import com.inpulsedj.ui.MonitorViewModel

class MainActivity : ComponentActivity() {
    private val vm: MonitorViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            InpulseTheme { MonitorScreen(vm) }
        }
    }

    override fun onResume() {
        super.onResume()
        vm.refreshAll()   // also runs after a USB attach launched us
    }
}
