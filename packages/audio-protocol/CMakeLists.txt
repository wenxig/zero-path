if(ESP_PLATFORM)
  idf_component_register(
    SRCS src/frame_codec.cpp
    INCLUDE_DIRS include
  )
  target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_26)
  target_compile_options(${COMPONENT_LIB} PRIVATE -std=gnu++26)
else()
  add_library(zero_path_audio_protocol STATIC
    src/frame_codec.cpp
  )
  add_library(zero_path::audio_protocol ALIAS zero_path_audio_protocol)
  target_include_directories(zero_path_audio_protocol PUBLIC include)
  target_link_libraries(zero_path_audio_protocol PUBLIC zero_path_project_options)

  if(BUILD_TESTING)
    find_package(Catch2 CONFIG REQUIRED)
    add_executable(audio_protocol_tests test/frame_codec_test.cpp)
    target_link_libraries(audio_protocol_tests PRIVATE
      zero_path::audio_protocol
      Catch2::Catch2WithMain
    )
    include(Catch)
    catch_discover_tests(audio_protocol_tests)
  endif()
endif()
