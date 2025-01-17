// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const sharp = require('sharp');

class ImageHandler {
    constructor(s3, rekognition) {
        this.s3 = s3;
        this.rekognition = rekognition;
    }

    /**
     * Main method for processing image requests and outputting modified images.
     * @param {ImageRequest} request - An ImageRequest object.
     */
    async process(request) {
        let returnImage = '';
        const originalImage = request.originalImage;
        const edits = request.edits;

        if (edits !== undefined && Object.keys(edits).length > 0) {
            let image = null;
            const keys = Object.keys(edits);

            if (keys.includes('rotate') && edits.rotate === null) {
                image = sharp(originalImage, { failOnError: false });
            } else {
                const metadata = await sharp(originalImage, { failOnError: false }).metadata();
                if (metadata.orientation) {
                    image = sharp(originalImage, { failOnError: false }).withMetadata({ orientation: metadata.orientation });
                } else {
                    image = sharp(originalImage, { failOnError: false }).withMetadata();
                }
            }

            const modifiedImage = await this.applyEdits(image, edits);
            if (request.outputFormat !== undefined) {
                modifiedImage.toFormat(request.outputFormat);
            }
            const bufferImage = await modifiedImage.toBuffer();
            returnImage = bufferImage.toString('base64');
        } else {
            returnImage = originalImage.toString('base64');
        }

        // If the converted image is larger than Lambda's payload hard limit, throw an error.
        const lambdaPayloadLimit = 6 * 1024 * 1024;
        if (returnImage.length > lambdaPayloadLimit) {
            throw {
                status: '413',
                code: 'TooLargeImageException',
                message: 'The converted image is too large to return.'
            };
        }

        return returnImage;
    }

    /**
     * Applies image modifications to the original image based on edits
     * specified in the ImageRequest.
     * @param {Sharp} image - The original sharp image.
     * @param {object} edits - The edits to be made to the original image.
     */
    async applyEdits(image, edits) {
        if (edits.resize === undefined) {
            edits.resize = {};
            edits.resize.fit = 'inside';
        } else {
            if (edits.resize.width) edits.resize.width = Math.round(Number(edits.resize.width));
            if (edits.resize.height) edits.resize.height = Math.round(Number(edits.resize.height));
        }

        // Apply the image edits
        for (const editKey in edits) {
            const value = edits[editKey];
            if (editKey === 'overlayWith') {
                const metadata = await image.metadata();
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }

                const { bucket, key, wRatio, hRatio, alpha } = value;
                const overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, alpha, imageMetadata);
                const overlayMetadata = await sharp(overlay).metadata();

                let { options } = value;
                if (options) {
                    if (options.left !== undefined) {
                        let left = options.left;
                        if (isNaN(left) && left.endsWith('p')) {
                            left = parseInt(left.replace('p', ''));
                            if (left < 0) {
                                left = imageMetadata.width + (imageMetadata.width * left / 100) - overlayMetadata.width;
                            } else {
                                left = imageMetadata.width * left / 100;
                            }
                        } else {
                            left = parseInt(left);
                            if (left < 0) {
                                left = imageMetadata.width + left - overlayMetadata.width;
                            }
                        }
                        isNaN(left) ? delete options.left : options.left = left;
                    }
                    if (options.top !== undefined) {
                        let top = options.top;
                        if (isNaN(top) && top.endsWith('p')) {
                            top = parseInt(top.replace('p', ''));
                            if (top < 0) {
                                top = imageMetadata.height + (imageMetadata.height * top / 100) - overlayMetadata.height;
                            } else {
                                top = imageMetadata.height * top / 100;
                            }
                        } else {
                            top = parseInt(top);
                            if (top < 0) {
                                top = imageMetadata.height + top - overlayMetadata.height;
                            }
                        }
                        isNaN(top) ? delete options.top : options.top = top;
                    }
                }

                const params = [{ ...options, input: overlay }];
                image.composite(params);
            } else if (editKey === 'smartCrop') {
                const options = value;
                const imageBuffer = await image.toBuffer({resolveWithObject: true});
                const boundingBox = await this.getBoundingBox(imageBuffer.data, options.faceIndex);
                const cropArea = this.getCropArea(boundingBox, options, imageBuffer.info);
                try {
                    image.extract(cropArea);
                } catch (err) {
                    throw {
                        status: 400,
                        code: 'SmartCrop::PaddingOutOfBounds',
                        message: 'The padding value you provided exceeds the boundaries of the original image. Please try choosing a smaller value or applying padding via Sharp for greater specificity.'
                    };
                }
            }  else if (editKey === 'roundCrop') {
                const options = value;
                const imageBuffer = await image.toBuffer({resolveWithObject: true});
                let width = imageBuffer.info.width;
                let height = imageBuffer.info.height;
                
                //check for parameters, if not provided, set to defaults
                const radiusX = options.rx && options.rx >= 0? options.rx : Math.min(width, height) / 2;
                const radiusY = options.ry && options.ry >= 0? options.ry : Math.min(width, height) / 2;
                const topOffset = options.top && options.top >= 0 ? options.top : height / 2;
                const leftOffset = options.left && options.left >= 0 ? options.left : width / 2;
                
                if(options)
                {
                    const ellipse = Buffer.from(`<svg viewBox="0 0 ${width} ${height}"> <ellipse cx="${leftOffset}" cy="${topOffset}" rx="${radiusX}" ry="${radiusY}" /></svg>`);
                    const params = [{ input: ellipse, blend: 'dest-in' }];
                    let data = await image.composite(params).toBuffer();
                    image = sharp(data).withMetadata().trim();
                }
                
            } else if (editKey === 'contentModeration') {
                const options = value;
                const imageBuffer = await image.toBuffer({resolveWithObject: true});
                const inappropriateContent = await this.detectInappropriateContent(imageBuffer.data, options);
                const blur = options.hasOwnProperty('blur') ? Math.ceil(Number(options.blur)) : 50; 
                
                if(options && (blur >= 0.3 && blur <= 1000)) {
                    if(options.moderationLabels){
                        for(let item of inappropriateContent.ModerationLabels) {
                            if (options.moderationLabels.includes(item.Name)){
                                image.blur(blur);
                                break;
                            }
                        }
                    } else if(inappropriateContent.ModerationLabels.length) {
                        image.blur(blur);                                   
                    }
                } 

            } else if (editKey === 'TEPWatermark') {
                const { options } = value;
                const { name = '', style = ''} = options;
                const metadata = await image.metadata();
                let watermark;
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }
                if (style === 'cute'){
                    watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50"><defs><style>.cls-1{opacity:0.2;}.cls-2{font-size:12px;font-family:'Poppins-SemiBold, Poppins';font-weight:600;text-anchor: middle;}.cls-2,.cls-3{fill:#fff;}</style></defs><g class="cls-1"><rect width="150" height="50"/></g><text class="cls-2" transform="translate(76.72 40.59)">${name}</text><path class="cls-3" d="M27.68,8.64V22H45.87V20.32a5,5,0,0,1-1.63-.59,4.87,4.87,0,0,1-1.87-2,6,6,0,0,1-.6-2.71,5.87,5.87,0,0,1,.6-2.68,4.83,4.83,0,0,1,1.85-2,5,5,0,0,1,1.65-.59V8.64L36.78,4Zm5.29.7h7.72v2.14H35.77V13h4.46v2.13H35.77v1.48h5.06V18.7H33Z"/><path class="cls-3" d="M46.36,16.4a1.88,1.88,0,0,1-.43-1.29,1.85,1.85,0,0,1,.43-1.28,1.44,1.44,0,0,1,1.13-.5,1.41,1.41,0,0,1,1.11.49A1.88,1.88,0,0,1,49,15.11a1.88,1.88,0,0,1-.43,1.29,1.41,1.41,0,0,1-1.11.49,1.47,1.47,0,0,1-1.13-.49M49,8.87v3.58a2.74,2.74,0,0,0-.94-.75,2.93,2.93,0,0,0-1.24-.26,3.37,3.37,0,0,0-1.73.44A3.1,3.1,0,0,0,44,13.15a4.22,4.22,0,0,0-.41,1.9A4.21,4.21,0,0,0,44,17a3.1,3.1,0,0,0,1.18,1.3,3.27,3.27,0,0,0,1.75.46,2.83,2.83,0,0,0,1.22-.25,2.46,2.46,0,0,0,.91-.76v.92H51.4V8.87Z"/><path class="cls-3" d="M55,16.07a1.68,1.68,0,0,1-.41-1.2,1.72,1.72,0,0,1,.41-1.2,1.42,1.42,0,0,1,2.1,0,1.77,1.77,0,0,1,.4,1.21,1.72,1.72,0,0,1-.4,1.2,1.3,1.3,0,0,1-1,.46A1.32,1.32,0,0,1,55,16.07m-1.17-4.21A2.84,2.84,0,0,0,52.8,13a4.33,4.33,0,0,0,0,3.57,2.9,2.9,0,0,0,2.68,1.64,2.44,2.44,0,0,0,2-.94v.76a1.22,1.22,0,0,1-.46,1,2,2,0,0,1-1.27.36,3.78,3.78,0,0,1-1.15-.18,4.06,4.06,0,0,1-1.07-.51l-.82,1.62a5.67,5.67,0,0,0,1.47.67,6.33,6.33,0,0,0,1.75.25,5,5,0,0,0,2-.4,3.11,3.11,0,0,0,1.37-1.15A3.06,3.06,0,0,0,59.9,18V11.52H57.54v.87a2.32,2.32,0,0,0-.9-.71,2.89,2.89,0,0,0-1.2-.24,3,3,0,0,0-1.57.42"/><path class="cls-3" d="M63.6,13.45a1.32,1.32,0,0,1,.94-.37,1.27,1.27,0,0,1,1,.38,1.34,1.34,0,0,1,.37,1H63.1a1.87,1.87,0,0,1,.5-1m-1-1.56a3.22,3.22,0,0,0-1.32,1.29,3.91,3.91,0,0,0-.46,1.93,3.9,3.9,0,0,0,.45,1.9,3.18,3.18,0,0,0,1.33,1.26,4.3,4.3,0,0,0,2,.45,4.84,4.84,0,0,0,1.79-.32,3.69,3.69,0,0,0,1.35-.94l-1.24-1.23a2.42,2.42,0,0,1-.79.54,2.34,2.34,0,0,1-.9.19,1.6,1.6,0,0,1-1.63-1.26h5c0-.09,0-.23,0-.42a4,4,0,0,0-.94-2.82,3.5,3.5,0,0,0-2.7-1,4.12,4.12,0,0,0-2,.45"/><path class="cls-3" d="M74.24,13.79a1.36,1.36,0,0,0,.41-1.06,1.34,1.34,0,0,0-.41-1,1.67,1.67,0,0,0-1.15-.36H71.55v2.83h1.54a1.62,1.62,0,0,0,1.15-.37M76,10.26a3,3,0,0,1,1,2.39,3.23,3.23,0,0,1-1,2.53,3.92,3.92,0,0,1-2.77.91H71.55v2.55H69.11V9.41h4.1a4.1,4.1,0,0,1,2.77.85"/><path class="cls-3" d="M81.23,11.75a2.7,2.7,0,0,1,1.35-.33v2.15h-.36a2.22,2.22,0,0,0-1.36.39,1.49,1.49,0,0,0-.6,1.06v3.63H77.89V11.52h2.37V12.7a2.6,2.6,0,0,1,1-.95"/><path class="cls-3" d="M85.61,13.82a1.85,1.85,0,0,0-.43,1.28,1.88,1.88,0,0,0,.43,1.29,1.43,1.43,0,0,0,1.12.49,1.45,1.45,0,0,0,1.13-.49,1.93,1.93,0,0,0,.42-1.29,1.85,1.85,0,0,0-.43-1.28,1.45,1.45,0,0,0-1.12-.49,1.43,1.43,0,0,0-1.12.49m3.18-1.93a3.41,3.41,0,0,1,1.38,1.28,3.61,3.61,0,0,1,.49,1.9A3.66,3.66,0,0,1,90.17,17a3.41,3.41,0,0,1-1.38,1.28,5,5,0,0,1-4.13,0A3.32,3.32,0,0,1,83.29,17a3.66,3.66,0,0,1-.49-1.92,3.61,3.61,0,0,1,.49-1.9,3.32,3.32,0,0,1,1.37-1.28,5,5,0,0,1,4.13,0"/><path class="cls-3" d="M96.34,16.34a1.9,1.9,0,0,0,.43-1.28,1.88,1.88,0,0,0-.43-1.28,1.44,1.44,0,0,0-1.13-.5,1.38,1.38,0,0,0-1.1.5,1.84,1.84,0,0,0-.43,1.28,1.85,1.85,0,0,0,.43,1.28,1.4,1.4,0,0,0,1.1.48,1.46,1.46,0,0,0,1.13-.48m1.21-4.45a3.07,3.07,0,0,1,1.18,1.29,4.25,4.25,0,0,1,.42,1.93,4.25,4.25,0,0,1-.41,1.9,3,3,0,0,1-1.15,1.26,3.32,3.32,0,0,1-1.74.45,2.91,2.91,0,0,1-1.23-.26,2.6,2.6,0,0,1-.94-.74v3.47H91.32V11.52h2.36v.92a2.55,2.55,0,0,1,2.12-1,3.35,3.35,0,0,1,1.75.45"/><path class="cls-3" d="M101.44,16.78a1.15,1.15,0,0,1-.83,2,1.07,1.07,0,0,1-.81-.33,1.12,1.12,0,0,1-.32-.82,1.16,1.16,0,0,1,.31-.82,1.12,1.12,0,0,1,.82-.31,1.14,1.14,0,0,1,.83.31"/><path class="cls-3" d="M114.07,12.16a2.77,2.77,0,0,1,.71,2v4.49h-2.37V14.82a1.32,1.32,0,0,0-.32-1,1.11,1.11,0,0,0-.86-.35,1.26,1.26,0,0,0-1,.45,1.73,1.73,0,0,0-.37,1.15v3.52H107.5V14.82a1.32,1.32,0,0,0-.32-1,1.11,1.11,0,0,0-.86-.35,1.29,1.29,0,0,0-1,.45,1.73,1.73,0,0,0-.37,1.15v3.52h-2.36V11.52H105v1.17a2.54,2.54,0,0,1,1-.94,2.82,2.82,0,0,1,1.38-.33,2.53,2.53,0,0,1,1.5.43,2.3,2.3,0,0,1,.9,1.17,2.5,2.5,0,0,1,1-1.19,2.78,2.78,0,0,1,1.52-.41,2.47,2.47,0,0,1,1.87.74"/><path class="cls-3" d="M118.81,20.82a2.93,2.93,0,0,1-1.72.48,3.31,3.31,0,0,1-1.11-.18,3.27,3.27,0,0,1-1-.56l1-1.62a2.27,2.27,0,0,0,.48.31,1.28,1.28,0,0,0,.48.09.9.9,0,0,0,.86-.54l.17-.33-3-6.95h2.43l1.72,4.63,1.53-4.63H123l-3.09,7.82a3.19,3.19,0,0,1-1.1,1.48"/></svg>`)
                } else {
                    watermark = new Buffer(`<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 340 140"><defs><style>.cls-1{fill:#fff;opacity:0.75;}.cls-2{font-size:14px;font-family:'OpenSans-Bold, Open Sans';font-weight:700;text-anchor: end;}</style></defs><rect class="cls-1" width="340" height="40.47"/><text class="cls-2" transform="translate(329.29 25.75)">${name}</text><image width="200" height="51" transform="translate(9.4 9.58) scale(0.42)" xlink:href="data:image/png;base64,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"/></svg>`)  
                }
                if (imageMetadata.width > 340 || (imageMetadata.width > 150 && style === 'cute')) {
                    const params = [{ ...options, input: watermark }];
                    image.composite(params);
                }
            } else {
                image[editKey](value);
            }
        }
        // Return the modified image
        return image;
    }

    /**
     * Gets an image to be used as an overlay to the primary image from an
     * Amazon S3 bucket.
     * @param {string} bucket - The name of the bucket containing the overlay.
     * @param {string} key - The object keyname corresponding to the overlay.
     * @param {number} wRatio - The width rate of the overlay image.
     * @param {number} hRatio - The height rate of the overlay image.
     * @param {number} alpha - The transparency alpha to the overlay.
     * @param {object} sourceImageMetadata - The metadata of the source image.
     */
    async getOverlayImage(bucket, key, wRatio, hRatio, alpha, sourceImageMetadata) {
        const params = { Bucket: bucket, Key: key };
        try {
            const { width, height } = sourceImageMetadata;
            const overlayImage = await this.s3.getObject(params).promise();
            let resize = {
                fit: 'inside'
            }

            // Set width and height of the watermark image based on the ratio
            const zeroToHundred = /^(100|[1-9]?[0-9])$/;
            if (zeroToHundred.test(wRatio)) {
                resize['width'] = parseInt(width * wRatio / 100);
            }
            if (zeroToHundred.test(hRatio)) {
                resize['height'] = parseInt(height * hRatio / 100);
            }

            // If alpha is not within 0-100, the default alpha is 0 (fully opaque).
            if (zeroToHundred.test(alpha)) {
                alpha = parseInt(alpha);
            } else {
                alpha = 0;
            }

            const convertedImage = await sharp(overlayImage.Body)
                .resize(resize)
                .composite([{
                    input: Buffer.from([255, 255, 255, 255 * (1 - alpha / 100)]),
                    raw: {
                        width: 1,
                        height: 1,
                        channels: 4
                    },
                    tile: true,
                    blend: 'dest-in'
                }]).toBuffer();
            return convertedImage;
        } catch (err) {
            throw {
                status: err.statusCode ? err.statusCode : 500,
                code: err.code,
                message: err.message
            };
        }
    }

    /**
     * Calculates the crop area for a smart-cropped image based on the bounding
     * box data returned by Amazon Rekognition, as well as padding options and
     * the image metadata.
     * @param {Object} boundingBox - The boudning box of the detected face.
     * @param {Object} options - Set of options for smart cropping.
     * @param {Object} metadata - Sharp image metadata.
     */
    getCropArea(boundingBox, options, metadata) {
        const padding = (options.padding !== undefined) ? parseFloat(options.padding) : 0;
        // Calculate the smart crop area
        const cropArea = {
            left : parseInt((boundingBox.Left * metadata.width) - padding),
            top : parseInt((boundingBox.Top * metadata.height) - padding),
            width : parseInt((boundingBox.Width * metadata.width) + (padding * 2)),
            height : parseInt((boundingBox.Height * metadata.height) + (padding * 2)),
        }
        // Return the crop area
        return cropArea;
    }

    /**
     * Gets the bounding box of the specified face index within an image, if specified.
     * @param {Sharp} imageBuffer - The original image.
     * @param {Integer} faceIndex - The zero-based face index value, moving from 0 and up as
     * confidence decreases for detected faces within the image.
     */
    async getBoundingBox(imageBuffer, faceIndex) {
        const params = { Image: { Bytes: imageBuffer }};
        const faceIdx = (faceIndex !== undefined) ? faceIndex : 0;
        try {
            const response = await this.rekognition.detectFaces(params).promise();
            if(response.FaceDetails.length <= 0) {
                return {Height: 1, Left: 0, Top: 0, Width: 1};
            }
            let boundingBox = {};

            //handle bounds > 1 and < 0
            for (let bound in response.FaceDetails[faceIdx].BoundingBox)
            {
                if (response.FaceDetails[faceIdx].BoundingBox[bound] < 0 ) boundingBox[bound] = 0; 
                else if (response.FaceDetails[faceIdx].BoundingBox[bound] > 1) boundingBox[bound] = 1; 
                else boundingBox[bound] = response.FaceDetails[faceIdx].BoundingBox[bound];
            }

            //handle bounds greater than the size of the image
            if (boundingBox.Left + boundingBox.Width > 1) {
                boundingBox.Width = 1 - boundingBox.Left;
            }
            if (boundingBox.Top + boundingBox.Height > 1) {
                boundingBox.Height = 1 - boundingBox.Top;
            }

            return boundingBox;
        } catch (err) {
            console.error(err);
            if (err.message === "Cannot read property 'BoundingBox' of undefined") {
                throw {
                    status: 400,
                    code: 'SmartCrop::FaceIndexOutOfRange',
                    message: 'You have provided a FaceIndex value that exceeds the length of the zero-based detectedFaces array. Please specify a value that is in-range.'
                };
            } else {
                throw {
                    status: err.statusCode ? err.statusCode : 500,
                    code: err.code,
                    message: err.message
                };
            }
        }
    }
    
    /**
     * Detects inappropriate content in an image.
     * @param {Sharp} imageBuffer - The original image.
     * @param {Object} options - The options to pass to the dectectModerationLables Rekognition function
     */
    async detectInappropriateContent(imageBuffer, options) {
        
        const params = {
            Image: {Bytes: imageBuffer},
            MinConfidence: options.minConfidence ? parseFloat(options.minConfidence) : 75
        }

        try {
            const response = await this.rekognition.detectModerationLabels(params).promise();
            return response;
        } catch(err) {
            console.error(err)
            throw {
                status: err.statusCode ? err.statusCode : 500,
                code: err.code,
                message: err.message
            }
        }
    }
}

// Exports
module.exports = ImageHandler;
