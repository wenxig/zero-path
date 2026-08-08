if(NOT DEFINED ENV{ZERO_PATH_LLVM_ROOT})
  message(FATAL_ERROR "ZERO_PATH_LLVM_ROOT must point to the Homebrew LLVM prefix")
endif()

set(CMAKE_C_COMPILER "$ENV{ZERO_PATH_LLVM_ROOT}/bin/clang" CACHE FILEPATH "Clang C compiler")
set(CMAKE_CXX_COMPILER "$ENV{ZERO_PATH_LLVM_ROOT}/bin/clang++" CACHE FILEPATH "Clang C++ compiler")
