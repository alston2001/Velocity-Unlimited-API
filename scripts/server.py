from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np
import cv2
import base64 
from vbt_tracker import VBT_Tracker

app = FastAPI()
tracker = VBT_Tracker()