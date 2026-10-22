#!/bin/bash

# Check if an argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <input_file_without_extension>"
  exit 1
fi

# Define input file by searching for valid extensions in the current directory
input_file=""
for ext in mp4 mov mpg mxf; do
  if [ -f "$1.$ext" ]; then
    input_file="$1.$ext"
    echo "Found input file: $input_file"
    break
  fi
done

# Exit if no valid file is found
if [ -z "$input_file" ]; then
  echo "Error: No valid input file found for '$1' with supported extensions (.mp4, .mov, .mpg, .mxf)"
  exit 1
fi

# Define output file paths in the same directory as the input file
scaled_file="$1_scaled.mp4"
final_file="$1_ticker.mp4"
ticker_image="ticker.png"

# Ensure ticker image exists in the current directory
if [ ! -f "$ticker_image" ]; then
  echo "Error: ticker.png not found in the current directory."
  exit 1
fi

# Scale the video
echo "Scaling video to 1204x676..."
if ffmpeg -y -i "$input_file" -vf scale=1204:676 "$scaled_file"; then
  echo "Scaling complete: $scaled_file created."
else
  echo "Error: Scaling failed."
  exit 1
fi

# Add overlay with ticker image
echo "Adding ticker overlay..."
if ffmpeg -y -i "$scaled_file" -i "$ticker_image" -filter_complex "pad=1280:720:36:0,overlay=0:648" -vb 2000k -ac 2 -ab 128k -s 1280x720 "$final_file"; then
  echo "Overlay added successfully: $final_file created."
else
  echo "Error: Overlay process failed."
  exit 1
fi

# Remove the intermediate scaled file if everything was successful
if [ -f "$final_file" ]; then
  rm "$scaled_file"
  echo "Cleanup complete: Removed $scaled_file."
else
  echo "Warning: Final file not found. Skipping cleanup."
fi
