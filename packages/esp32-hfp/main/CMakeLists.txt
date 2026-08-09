idf_component_register(
  SRCS app_main.cpp spp_audio_test_server.cpp
  PRIV_REQUIRES audio-protocol bt nvs_flash esp_timer
  INCLUDE_DIRS "."
)

target_compile_features(${COMPONENT_LIB} PRIVATE cxx_std_26)
target_compile_options(${COMPONENT_LIB} PRIVATE -std=gnu++26)
