/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <WebDriverAgentLib/FBCommandHandler.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Photos commands handler for WebDriverAgent
 * Provides access to device photo library via HTTP API
 */
@interface FBPhotosCommands : NSObject <FBCommandHandler>
@end

NS_ASSUME_NONNULL_END
